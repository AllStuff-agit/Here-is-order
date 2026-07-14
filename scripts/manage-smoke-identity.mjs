import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCloudflareD1RestClient } from './cloudflare-d1-rest.mjs';
import { createPasswordHash } from './generate-admin-seed.mjs';
import { readProductionD1Binding } from './recover-password.mjs';
import {
  SMOKE_IDENTITY,
  SMOKE_IDENTITY_ACTIONS,
  expectedSmokeIdentityConfirmation,
  parseSmokeIdentityArgs,
  validateSmokeIdentityPassword,
} from './smoke-identity-contract.mjs';
import { runSmokeIdentityLifecycle } from './smoke-identity-lifecycle.mjs';

export const SMOKE_IDENTITY_OPERATION_VERSION = 'production-smoke-identity-operation-v1';
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const RUN_ID_PATTERN = /^[1-9]\d*$/;
const DATABASE_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function nonblank(value) {
  return typeof value === 'string' && value.length > 0
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function isExactIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function parseSmokeIdentityEnvironment({ env, action }) {
  try {
    const needsPassword = action !== 'disable';
    if (!env
      || env.CI !== 'true'
      || env.GITHUB_ACTIONS !== 'true'
      || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || env.GITHUB_REF !== 'refs/heads/main'
      || !RUN_ID_PATTERN.test(env.GITHUB_RUN_ID)
      || !RUN_ID_PATTERN.test(env.GITHUB_RUN_ATTEMPT)
      || !ACCOUNT_ID_PATTERN.test(env.CLOUDFLARE_ACCOUNT_ID)
      || !nonblank(env.CLOUDFLARE_API_TOKEN)
      || env.SMOKE_IDENTITY_CONFIRMATION !== expectedSmokeIdentityConfirmation(action)
      || !path.isAbsolute(env.GITHUB_STEP_SUMMARY)
      || path.normalize(env.GITHUB_STEP_SUMMARY) !== env.GITHUB_STEP_SUMMARY
      || (!needsPassword && env.PRODUCTION_SMOKE_PASSWORD !== undefined)) {
      throw new Error('invalid environment');
    }
    return Object.freeze({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      password: needsPassword
        ? validateSmokeIdentityPassword(env.PRODUCTION_SMOKE_PASSWORD)
        : undefined,
      summaryPath: env.GITHUB_STEP_SUMMARY,
    });
  } catch {
    throw new Error('Smoke identity environment was invalid.');
  }
}

export function buildSmokeIdentityOperationReport({ executedAt, action }) {
  const report = {
    operationVersion: SMOKE_IDENTITY_OPERATION_VERSION,
    executedAt,
    databaseName: SMOKE_IDENTITY.databaseName,
    action,
    outcome: 'completed',
  };
  if (!isExactIsoTimestamp(executedAt)
    || !SMOKE_IDENTITY_ACTIONS.includes(action)) {
    throw new Error('Smoke identity report was invalid.');
  }
  return Object.freeze(report);
}

export function assertSmokeIdentityRemoteTarget(matches, binding) {
  if (!Array.isArray(matches)
    || matches.length !== 1
    || !matches[0]
    || typeof matches[0] !== 'object'
    || Array.isArray(matches[0])
    || Object.keys(matches[0]).sort().join(',') !== 'name,uuid'
    || matches[0].name !== SMOKE_IDENTITY.databaseName
    || matches[0].uuid !== binding.databaseId) {
    throw new Error('Smoke identity remote target was invalid.');
  }
  return Object.freeze({
    databaseName: SMOKE_IDENTITY.databaseName,
    databaseId: binding.databaseId,
  });
}

export function renderSmokeIdentityOperationSummary(report) {
  const expectedKeys = ['operationVersion', 'executedAt', 'databaseName', 'action', 'outcome'];
  if (!report
    || Object.keys(report).join(',') !== expectedKeys.join(',')
    || report.operationVersion !== SMOKE_IDENTITY_OPERATION_VERSION
    || report.databaseName !== SMOKE_IDENTITY.databaseName
    || !SMOKE_IDENTITY_ACTIONS.includes(report.action)
    || report.outcome !== 'completed'
    || !isExactIsoTimestamp(report.executedAt)) {
    throw new Error('Smoke identity report was invalid.');
  }
  return `## Production smoke identity operation\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}

export async function runManageSmokeIdentity({
  argv = process.argv.slice(2),
  env = process.env,
  now = () => new Date(),
  configPath = 'wrangler.toml',
  readBinding = readProductionD1Binding,
  createHash = createPasswordHash,
  createClient = createCloudflareD1RestClient,
  runLifecycle = runSmokeIdentityLifecycle,
  appendSummary = (filePath, contents) => fs.appendFileSync(filePath, contents, 'utf8'),
  log = (contents) => console.log(contents),
} = {}) {
  try {
    const { action } = parseSmokeIdentityArgs(argv);
    const environment = parseSmokeIdentityEnvironment({ env, action });
    const binding = readBinding({
      configPath,
      binding: SMOKE_IDENTITY.databaseBinding,
    });
    if (binding.binding !== SMOKE_IDENTITY.databaseBinding
      || binding.databaseName !== SMOKE_IDENTITY.databaseName
      || !DATABASE_ID_PATTERN.test(binding.databaseId)) {
      throw new Error('invalid binding');
    }
    const client = createClient({
      accountId: environment.accountId,
      apiToken: environment.apiToken,
    });
    assertSmokeIdentityRemoteTarget(
      await client.listDatabasesByExactName(SMOKE_IDENTITY.databaseName),
      binding,
    );
    const passwordHash = environment.password === undefined
      ? undefined
      : createHash(environment.password);
    await runLifecycle({
      client,
      databaseId: binding.databaseId,
      action,
      passwordHash,
    });
    const currentTime = now();
    const report = buildSmokeIdentityOperationReport({
      executedAt: currentTime.toISOString(),
      action,
    });
    await appendSummary(
      environment.summaryPath,
      renderSmokeIdentityOperationSummary(report),
    );
    await log(JSON.stringify(report));
    return report;
  } catch {
    throw new Error('Smoke identity operation failed.');
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runManageSmokeIdentity().catch(() => {
    console.error('Smoke identity operation failed.');
    process.exitCode = 1;
  });
}
