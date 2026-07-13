import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCloudflareD1RestClient } from './cloudflare-d1-rest.mjs';
import { readProductionD1Binding } from './recover-password.mjs';

export const PREFLIGHT_VERSION = 'production-deployment-preflight-v1';
export const APPLIED_MIGRATIONS_SQL =
  'SELECT id, name, applied_at FROM d1_migrations ORDER BY id';

const DATABASE_NAME = 'hereisorder';
const API_WORKER_NAME = 'hereisorder';
const WEB_WORKER_NAME = 'hereisorder-web';
const DATABASE_UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const BOOKMARK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const MIGRATION_NAME_PATTERN = /^(\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const SQLITE_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const RFC3339_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9]\d*$/;
const REPORT_KEYS = [
  'preflightVersion',
  'executedAt',
  'gitSha',
  'runId',
  'runAttempt',
  'databaseName',
  'databaseId',
  'bookmark',
  'appliedMigrations',
  'pendingMigrations',
  'previousDeployments',
  'outcome',
];
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hasExactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...keys].sort());
}

function isUuid(value) {
  return typeof value === 'string' && DATABASE_UUID_PATTERN.test(value);
}

function isNonblankCredential(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function migrationNumber(name) {
  const match = typeof name === 'string' && name.match(MIGRATION_NAME_PATTERN);
  return match ? Number.parseInt(match[1], 10) : null;
}

function isValidUtcParts(match) {
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const values = [year, month, day, hour, minute, second].map(Number);
  const date = new Date(Date.UTC(
    values[0],
    values[1] - 1,
    values[2],
    values[3],
    values[4],
    values[5],
  ));
  return Number.isFinite(date.getTime())
    && date.getUTCFullYear() === values[0]
    && date.getUTCMonth() + 1 === values[1]
    && date.getUTCDate() === values[2]
    && date.getUTCHours() === values[3]
    && date.getUTCMinutes() === values[4]
    && date.getUTCSeconds() === values[5];
}

function isSqliteUtcTimestamp(value) {
  return typeof value === 'string'
    && isValidUtcParts(value.match(SQLITE_UTC_PATTERN));
}

function isRfc3339UtcTimestamp(value) {
  return typeof value === 'string'
    && isValidUtcParts(value.match(RFC3339_UTC_PATTERN))
    && Number.isFinite(Date.parse(value));
}

function timestampOrderKey(value) {
  const match = value.match(RFC3339_UTC_PATTERN);
  return `${match.slice(1, 7).join('')}${(match[7] ?? '').padEnd(9, '0')}`;
}

function validateManifestNames(names) {
  if (!Array.isArray(names) || names.length === 0) return false;

  const numbers = [];
  const seenNames = new Set();
  const seenNumbers = new Set();
  for (const name of names) {
    const number = migrationNumber(name);
    if (number === null || seenNames.has(name) || seenNumbers.has(number)) return false;
    seenNames.add(name);
    seenNumbers.add(number);
    numbers.push(number);
  }
  return numbers.every((number, index) => index === 0 || numbers[index - 1] < number);
}

function validateAppliedRows(rows) {
  if (!Array.isArray(rows)) return false;
  const names = new Set();
  return rows.every((row, index) => {
    if (!hasExactKeys(row, ['id', 'name', 'applied_at'])
      || !Number.isSafeInteger(row.id)
      || row.id !== index + 1
      || migrationNumber(row.name) === null
      || names.has(row.name)
      || !isSqliteUtcTimestamp(row.applied_at)) {
      return false;
    }
    names.add(row.name);
    return true;
  });
}

function validateDeploymentSnapshot(value) {
  if (!hasExactKeys(value, ['deploymentId', 'createdOn', 'versions'])
    || !isUuid(value.deploymentId)
    || !isRfc3339UtcTimestamp(value.createdOn)
    || !Array.isArray(value.versions)
    || value.versions.length !== 1) {
    return false;
  }
  const [version] = value.versions;
  return hasExactKeys(version, ['versionId', 'percentage'])
    && isUuid(version.versionId)
    && version.percentage === 100;
}

function cloneDeploymentSnapshot(value) {
  return {
    deploymentId: value.deploymentId,
    createdOn: value.createdOn,
    versions: value.versions.map(({ versionId, percentage }) => ({
      versionId,
      percentage,
    })),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function readMigrationManifest({
  migrationsDir = path.join(REPOSITORY_ROOT, 'migrations'),
} = {}) {
  try {
    const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
    const names = entries.map((entry) => {
      if (!entry.isFile()) throw new Error('invalid manifest entry');
      return entry.name;
    }).sort((left, right) => {
      const leftNumber = migrationNumber(left);
      const rightNumber = migrationNumber(right);
      if (leftNumber === null || rightNumber === null) return left.localeCompare(right);
      return leftNumber - rightNumber || left.localeCompare(right);
    });
    if (!validateManifestNames(names)) throw new Error('invalid manifest');
    return names;
  } catch {
    throw new Error('Production migration manifest was invalid.');
  }
}

export function parseAppliedMigrationResult(queryResults) {
  try {
    if (!Array.isArray(queryResults)
      || queryResults.length !== 1
      || queryResults[0]?.success !== true
      || !validateAppliedRows(queryResults[0].results)) {
      throw new Error('invalid applied migration result');
    }
    return queryResults[0].results.map(({ id, name, applied_at: appliedAt }) => ({
      id,
      name,
      applied_at: appliedAt,
    }));
  } catch {
    throw new Error('Production applied migration state was invalid.');
  }
}

export function findPendingMigrations(localMigrations, appliedMigrations) {
  try {
    if (!validateManifestNames(localMigrations)
      || !validateAppliedRows(appliedMigrations)
      || appliedMigrations.length > localMigrations.length
      || appliedMigrations.some((row, index) => row.name !== localMigrations[index])) {
      throw new Error('divergent migrations');
    }
    return localMigrations.slice(appliedMigrations.length);
  } catch {
    throw new Error('Production migration divergence was detected.');
  }
}

function parseDeploymentEntry(value) {
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !isUuid(value.id)
    || !isRfc3339UtcTimestamp(value.created_on)
    || !Array.isArray(value.versions)
    || value.versions.length === 0) {
    return null;
  }

  const versionIds = new Set();
  let allocation = 0;
  const versions = [];
  for (const version of value.versions) {
    if (!version
      || typeof version !== 'object'
      || Array.isArray(version)
      || !isUuid(version.version_id)
      || versionIds.has(version.version_id)
      || typeof version.percentage !== 'number'
      || !Number.isFinite(version.percentage)
      || version.percentage <= 0
      || version.percentage > 100) {
      return null;
    }
    versionIds.add(version.version_id);
    allocation += version.percentage;
    versions.push({ versionId: version.version_id, percentage: version.percentage });
  }
  if (allocation !== 100) return null;

  return {
    deploymentId: value.id,
    createdOn: value.created_on,
    timestampOrderKey: timestampOrderKey(value.created_on),
    versions,
  };
}

export function parseActiveDeployment(result) {
  try {
    if (!result
      || typeof result !== 'object'
      || Array.isArray(result)
      || !Array.isArray(result.deployments)
      || result.deployments.length === 0) {
      throw new Error('missing deployments');
    }

    const parsed = result.deployments.map(parseDeploymentEntry);
    if (parsed.some((deployment) => deployment === null)) {
      throw new Error('malformed deployment');
    }
    parsed.sort((left, right) => {
      if (left.timestampOrderKey !== right.timestampOrderKey) {
        return left.timestampOrderKey > right.timestampOrderKey ? -1 : 1;
      }
      return left.deploymentId.localeCompare(right.deploymentId);
    });
    const active = parsed[0];
    if (active.versions.length !== 1 || active.versions[0].percentage !== 100) {
      throw new Error('ambiguous deployment');
    }
    return cloneDeploymentSnapshot(active);
  } catch {
    throw new Error('Production active Worker deployment was invalid.');
  }
}

export async function readActiveWorkerDeployment({
  accountId,
  apiToken,
  workerName,
  fetchImpl = fetch,
  baseUrl = 'https://api.cloudflare.com/client/v4',
}) {
  try {
    if (typeof accountId !== 'string'
      || accountId.length === 0
      || typeof apiToken !== 'string'
      || apiToken.length === 0
      || ![API_WORKER_NAME, WEB_WORKER_NAME].includes(workerName)
      || typeof baseUrl !== 'string'
      || baseUrl.length === 0) {
      throw new Error('invalid Worker deployment request');
    }
    const response = await fetchImpl(
      `${baseUrl}/accounts/${encodeURIComponent(accountId)}`
        + `/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiToken}` },
      },
    );
    const envelope = await response.json();
    if (!response.ok || envelope?.success !== true) {
      throw new Error('unsuccessful Worker deployment response');
    }
    return parseActiveDeployment(envelope.result);
  } catch {
    throw new Error('Cloudflare Worker deployment request failed.');
  }
}

function validateReportInput({
  executedAt,
  gitSha,
  runId,
  runAttempt,
  databaseName,
  databaseId,
  bookmark,
  appliedMigrations,
  pendingMigrations,
  previousDeployments,
}) {
  const completeManifest = Array.isArray(appliedMigrations)
    && Array.isArray(pendingMigrations)
    ? [...appliedMigrations, ...pendingMigrations]
    : null;
  return typeof executedAt === 'string'
    && (() => {
      try {
        return new Date(executedAt).toISOString() === executedAt;
      } catch {
        return false;
      }
    })()
    && GIT_SHA_PATTERN.test(gitSha)
    && RUN_ID_PATTERN.test(runId)
    && Number.isSafeInteger(runAttempt)
    && runAttempt > 0
    && databaseName === DATABASE_NAME
    && isUuid(databaseId)
    && typeof bookmark === 'string'
    && BOOKMARK_PATTERN.test(bookmark)
    && validateManifestNames(completeManifest)
    && previousDeployments
    && typeof previousDeployments === 'object'
    && !Array.isArray(previousDeployments)
    && hasExactKeys(previousDeployments, ['api', 'web'])
    && validateDeploymentSnapshot(previousDeployments.api)
    && validateDeploymentSnapshot(previousDeployments.web);
}

export function buildPreflightReport(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || !validateReportInput(input)) {
      throw new Error('invalid report input');
    }
    const report = {
      preflightVersion: PREFLIGHT_VERSION,
      executedAt: input.executedAt,
      gitSha: input.gitSha,
      runId: input.runId,
      runAttempt: input.runAttempt,
      databaseName: input.databaseName,
      databaseId: input.databaseId,
      bookmark: input.bookmark,
      appliedMigrations: [...input.appliedMigrations],
      pendingMigrations: [...input.pendingMigrations],
      previousDeployments: {
        api: cloneDeploymentSnapshot(input.previousDeployments.api),
        web: cloneDeploymentSnapshot(input.previousDeployments.web),
      },
      outcome: 'ready',
    };
    return deepFreeze(report);
  } catch {
    throw new Error('Production preflight report was invalid.');
  }
}

function isExactReport(value) {
  return hasExactKeys(value, REPORT_KEYS)
    && value.preflightVersion === PREFLIGHT_VERSION
    && value.outcome === 'ready'
    && validateReportInput(value);
}

export function renderPreflightSummary(report) {
  if (!isExactReport(report)) {
    throw new Error('Production preflight report was invalid.');
  }
  return `## Production deployment checkpoint\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}

function validateEnvironment(env) {
  const runAttempt = Number(env?.GITHUB_RUN_ATTEMPT);
  if (!env
    || typeof env !== 'object'
    || env.CI !== 'true'
    || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
    || env.GITHUB_REF !== 'refs/heads/main'
    || !GIT_SHA_PATTERN.test(env.GITHUB_SHA)
    || !RUN_ID_PATTERN.test(env.GITHUB_RUN_ID)
    || !RUN_ID_PATTERN.test(env.GITHUB_RUN_ATTEMPT)
    || !Number.isSafeInteger(runAttempt)
    || runAttempt <= 0
    || !isNonblankCredential(env.CLOUDFLARE_ACCOUNT_ID)
    || !isNonblankCredential(env.CLOUDFLARE_API_TOKEN)
    || typeof env.GITHUB_STEP_SUMMARY !== 'string'
    || !path.isAbsolute(env.GITHUB_STEP_SUMMARY)) {
    throw new Error('invalid deployment environment');
  }
}

function validateBinding(binding) {
  return hasExactKeys(binding, ['binding', 'databaseName', 'databaseId'])
    && binding.binding === 'DB'
    && binding.databaseName === DATABASE_NAME
    && isUuid(binding.databaseId);
}

function validateRemoteDatabase(databases, binding) {
  return Array.isArray(databases)
    && databases.length === 1
    && hasExactKeys(databases[0], ['name', 'uuid'])
    && databases[0].name === binding.databaseName
    && databases[0].uuid === binding.databaseId;
}

export async function runProductionPreflight({
  env = process.env,
  now = () => new Date(),
  fetchImpl = fetch,
  configPath = path.join(REPOSITORY_ROOT, 'wrangler.toml'),
  migrationsDir = path.join(REPOSITORY_ROOT, 'migrations'),
  readBinding = ({ targetConfigPath }) => readProductionD1Binding({
    configPath: targetConfigPath,
    binding: 'DB',
  }),
  readManifest = ({ targetMigrationsDir }) => readMigrationManifest({
    migrationsDir: targetMigrationsDir,
  }),
  createD1Client = (options) => createCloudflareD1RestClient(options),
  readDeployment = readActiveWorkerDeployment,
  appendSummary = (summaryPath, contents) => fs.appendFileSync(summaryPath, contents, 'utf8'),
  log = (value) => console.log(value),
} = {}) {
  try {
    validateEnvironment(env);

    const binding = readBinding({ targetConfigPath: configPath });
    if (!validateBinding(binding)) throw new Error('invalid D1 binding');

    const d1Client = createD1Client({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      fetchImpl,
    });
    const databases = await d1Client.listDatabasesByExactName(DATABASE_NAME);
    if (!validateRemoteDatabase(databases, binding)) {
      throw new Error('D1 database identity mismatch');
    }

    const bookmark = await d1Client.getTimeTravelBookmark(binding.databaseId);
    if (typeof bookmark !== 'string' || !BOOKMARK_PATTERN.test(bookmark)) {
      throw new Error('invalid Time Travel bookmark');
    }
    const queryResults = await d1Client.query(binding.databaseId, {
      sql: APPLIED_MIGRATIONS_SQL,
      params: [],
    });
    const appliedRows = parseAppliedMigrationResult(queryResults);
    const localMigrations = readManifest({ targetMigrationsDir: migrationsDir });
    const pendingMigrations = findPendingMigrations(localMigrations, appliedRows);

    const deploymentOptions = {
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      fetchImpl,
    };
    const apiDeployment = await readDeployment({
      ...deploymentOptions,
      workerName: API_WORKER_NAME,
    });
    const webDeployment = await readDeployment({
      ...deploymentOptions,
      workerName: WEB_WORKER_NAME,
    });

    const currentTime = now();
    if (!(currentTime instanceof Date) || !Number.isFinite(currentTime.getTime())) {
      throw new Error('invalid preflight time');
    }
    const report = buildPreflightReport({
      executedAt: currentTime.toISOString(),
      gitSha: env.GITHUB_SHA,
      runId: env.GITHUB_RUN_ID,
      runAttempt: Number.parseInt(env.GITHUB_RUN_ATTEMPT, 10),
      databaseName: binding.databaseName,
      databaseId: binding.databaseId,
      bookmark,
      appliedMigrations: appliedRows.map(({ name }) => name),
      pendingMigrations,
      previousDeployments: {
        api: apiDeployment,
        web: webDeployment,
      },
    });

    await appendSummary(env.GITHUB_STEP_SUMMARY, renderPreflightSummary(report));
    await log(JSON.stringify(report));
    return report;
  } catch {
    throw new Error('Production deployment preflight failed.');
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runProductionPreflight().catch(() => {
    console.error('Production deployment preflight failed.');
    process.exitCode = 1;
  });
}
