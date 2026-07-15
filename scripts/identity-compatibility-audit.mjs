import { randomUUID as createRandomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCloudflareD1RestClient } from './cloudflare-d1-rest.mjs';
import { readProductionD1Binding } from './recover-password.mjs';

export const IDENTITY_COMPATIBILITY_AUDIT_VERSION = 'identity-compatibility-v1';
export const IDENTITY_COMPATIBILITY_SQL = fs.readFileSync(
  new URL('./sql/identity-compatibility-v1.sql', import.meta.url),
  'utf8',
);
const QUERY_FIELDS = [
  'audit_version',
  'legacy_password_hash_count',
  'unsupported_password_hash_count',
  'invalid_identity_projection_count',
];
const REPORT_FIELDS = [
  'auditVersion',
  'executedAt',
  'gitSha',
  'requestId',
  'legacyPasswordHashCount',
  'unsupportedPasswordHashCount',
  'invalidIdentityProjectionCount',
  'outcome',
];
const REPORT_INPUT_FIELDS = [
  'row',
  'executedAt',
  'gitSha',
  'requestId',
];
const BINDING_FIELDS = [
  'binding',
  'databaseName',
  'databaseId',
];
const REMOTE_TARGET_FIELDS = [
  'name',
  'uuid',
];
const MUTATING_SQL_KEYWORD = new RegExp(
  '\\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|TRIGGER)\\b',
  'i',
);
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const RUN_ID_PATTERN = /^[1-9]\d*$/;
const DATABASE_UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_ENVIRONMENT_FIELDS = new Set([
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_FORWARD_DEPLOY_TOKEN',
  'CLOUDFLARE_D1_TOKEN',
  'CLOUDFLARE_DATABASE_ID',
  'D1_DATABASE_ID',
  'IDENTITY_COMPATIBILITY_SQL',
  'SQL',
]);

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataFields(value, fields, ordered) {
  if (!isPlainRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== fields.length || ownKeys.some((key) => typeof key !== 'string')) {
    return false;
  }
  const stringKeys = ownKeys;
  if (ordered) {
    if (!stringKeys.every((key, index) => key === fields[index])) return false;
  } else if (!stringKeys.every((key) => fields.includes(key))) {
    return false;
  }
  return stringKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true
      && Object.prototype.hasOwnProperty.call(descriptor, 'value');
  });
}

function hasOwnEnumerableDataField(value, field) {
  if (!isPlainRecord(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor?.enumerable === true
    && Object.prototype.hasOwnProperty.call(descriptor, 'value');
}

function isNonnegativeSafeInteger(value) {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isNonblank(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseIdentityCompatibilityRow(row) {
  if (!hasExactDataFields(row, QUERY_FIELDS, true)
    || row.audit_version !== IDENTITY_COMPATIBILITY_AUDIT_VERSION
    || !isNonnegativeSafeInteger(row.legacy_password_hash_count)
    || !isNonnegativeSafeInteger(row.unsupported_password_hash_count)
    || !isNonnegativeSafeInteger(row.invalid_identity_projection_count)) {
    throw new Error('invalid identity compatibility row');
  }
  return {
    audit_version: row.audit_version,
    legacy_password_hash_count: row.legacy_password_hash_count,
    unsupported_password_hash_count: row.unsupported_password_hash_count,
    invalid_identity_projection_count: row.invalid_identity_projection_count,
  };
}

function assertExactBinding(binding) {
  if (!hasExactDataFields(binding, BINDING_FIELDS, false)
    || binding.binding !== 'DB'
    || binding.databaseName !== 'hereisorder'
    || typeof binding.databaseId !== 'string'
    || !DATABASE_UUID_PATTERN.test(binding.databaseId)) {
    throw new Error('Identity compatibility binding was invalid.');
  }
}

function assertIdentityCompatibilityReport(report) {
  if (!hasExactDataFields(report, REPORT_FIELDS, true)
    || report.auditVersion !== IDENTITY_COMPATIBILITY_AUDIT_VERSION
    || !isCanonicalIsoTimestamp(report.executedAt)
    || typeof report.gitSha !== 'string'
    || !GIT_SHA_PATTERN.test(report.gitSha)
    || typeof report.requestId !== 'string'
    || !UUID_V4_PATTERN.test(report.requestId)
    || !isNonnegativeSafeInteger(report.legacyPasswordHashCount)
    || !isNonnegativeSafeInteger(report.unsupportedPasswordHashCount)
    || !isNonnegativeSafeInteger(report.invalidIdentityProjectionCount)
    || report.outcome !== 'verified') {
    throw new Error('Identity compatibility report was invalid.');
  }
}

function scrubIdentityAuditSql(sql) {
  if (typeof sql !== 'string' || sql.includes('\0')) {
    throw new Error('invalid SQL');
  }

  let scrubbed = '';
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === '-' && next === '-') {
      scrubbed += '  ';
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') {
        scrubbed += ' ';
        index += 1;
      }
      continue;
    }

    if (character === '/' && next === '*') {
      scrubbed += '  ';
      index += 2;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '*' && sql[index + 1] === '/') {
          scrubbed += '  ';
          index += 2;
          closed = true;
          break;
        }
        scrubbed += sql[index] === '\n' || sql[index] === '\r' ? sql[index] : ' ';
        index += 1;
      }
      if (!closed) throw new Error('invalid SQL');
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      scrubbed += ' ';
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            scrubbed += '  ';
            index += 2;
            continue;
          }
          scrubbed += ' ';
          index += 1;
          closed = true;
          break;
        }
        scrubbed += sql[index] === '\n' || sql[index] === '\r' ? sql[index] : ' ';
        index += 1;
      }
      if (!closed) throw new Error('invalid SQL');
      continue;
    }

    if (character === '[') {
      scrubbed += ' ';
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === ']') {
          scrubbed += ' ';
          index += 1;
          closed = true;
          break;
        }
        scrubbed += sql[index] === '\n' || sql[index] === '\r' ? sql[index] : ' ';
        index += 1;
      }
      if (!closed) throw new Error('invalid SQL');
      continue;
    }

    scrubbed += character;
    index += 1;
  }
  return scrubbed;
}

export function assertReadOnlyIdentityAuditSql(sql) {
  try {
    const scrubbed = scrubIdentityAuditSql(sql);
    const statements = scrubbed
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    if (statements.length !== 1
      || !/^(?:WITH|SELECT)\b/i.test(statements[0])
      || MUTATING_SQL_KEYWORD.test(statements[0])) {
      throw new Error('invalid SQL');
    }
  } catch {
    throw new Error('Identity compatibility audit SQL must be a read-only single statement.');
  }
}

export function parseIdentityCompatibilityEnvironment(env) {
  try {
    if (!env
      || typeof env !== 'object'
      || Array.isArray(env)
      || env.CI !== 'true'
      || env.GITHUB_ACTIONS !== 'true'
      || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || env.GITHUB_REF !== 'refs/heads/main'
      || typeof env.GITHUB_SHA !== 'string'
      || !GIT_SHA_PATTERN.test(env.GITHUB_SHA)
      || typeof env.GITHUB_RUN_ID !== 'string'
      || !RUN_ID_PATTERN.test(env.GITHUB_RUN_ID)
      || typeof env.GITHUB_RUN_ATTEMPT !== 'string'
      || !RUN_ID_PATTERN.test(env.GITHUB_RUN_ATTEMPT)
      || !isNonblank(env.GITHUB_STEP_SUMMARY)
      || !path.isAbsolute(env.GITHUB_STEP_SUMMARY)
      || path.normalize(env.GITHUB_STEP_SUMMARY) !== env.GITHUB_STEP_SUMMARY
      || typeof env.CLOUDFLARE_ACCOUNT_ID !== 'string'
      || !ACCOUNT_ID_PATTERN.test(env.CLOUDFLARE_ACCOUNT_ID)
      || !isNonblank(env.CLOUDFLARE_D1_READ_TOKEN)
      || Object.keys(env).some((field) => (
        field.startsWith('INPUT_') || FORBIDDEN_ENVIRONMENT_FIELDS.has(field)
      ))) {
      throw new Error('invalid environment');
    }
    return Object.freeze({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      readToken: env.CLOUDFLARE_D1_READ_TOKEN,
      gitSha: env.GITHUB_SHA,
      summaryPath: env.GITHUB_STEP_SUMMARY,
    });
  } catch {
    throw new Error('Identity compatibility environment was invalid.');
  }
}

export function assertIdentityCompatibilityRemoteTarget(matches, binding) {
  try {
    assertExactBinding(binding);
    if (!Array.isArray(matches)
      || matches.length !== 1
      || !hasExactDataFields(matches[0], REMOTE_TARGET_FIELDS, false)
      || matches[0].name !== 'hereisorder'
      || matches[0].uuid !== binding.databaseId) {
      throw new Error('invalid remote target');
    }
  } catch {
    throw new Error('Identity compatibility remote target was invalid.');
  }
}

export function parseIdentityCompatibilityResult(results) {
  try {
    if (!Array.isArray(results)
      || results.length !== 1
      || !hasOwnEnumerableDataField(results[0], 'success')
      || !hasOwnEnumerableDataField(results[0], 'results')
      || results[0].success !== true
      || !Array.isArray(results[0].results)
      || results[0].results.length !== 1) {
      throw new Error('invalid result');
    }
    return parseIdentityCompatibilityRow(results[0].results[0]);
  } catch {
    throw new Error('Identity compatibility result was invalid.');
  }
}

export function buildIdentityCompatibilityReport(input) {
  try {
    if (!hasExactDataFields(input, REPORT_INPUT_FIELDS, false)
      || !isCanonicalIsoTimestamp(input.executedAt)
      || typeof input.gitSha !== 'string'
      || !GIT_SHA_PATTERN.test(input.gitSha)
      || typeof input.requestId !== 'string'
      || !UUID_V4_PATTERN.test(input.requestId)) {
      throw new Error('invalid report input');
    }
    const row = parseIdentityCompatibilityRow(input.row);
    return Object.freeze({
      auditVersion: IDENTITY_COMPATIBILITY_AUDIT_VERSION,
      executedAt: input.executedAt,
      gitSha: input.gitSha,
      requestId: input.requestId,
      legacyPasswordHashCount: row.legacy_password_hash_count,
      unsupportedPasswordHashCount: row.unsupported_password_hash_count,
      invalidIdentityProjectionCount: row.invalid_identity_projection_count,
      outcome: 'verified',
    });
  } catch {
    throw new Error('Identity compatibility report was invalid.');
  }
}

export function identityCompatibilityGatePassed(report) {
  assertIdentityCompatibilityReport(report);
  return report.unsupportedPasswordHashCount === 0
    && report.invalidIdentityProjectionCount === 0;
}

export function renderIdentityCompatibilitySummary(report) {
  assertIdentityCompatibilityReport(report);
  return `## Identity compatibility audit\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}

export async function runIdentityCompatibilityAudit(options = {}) {
  try {
    const configuredArgv = options.argv;
    const argv = configuredArgv === undefined
      ? process.argv.slice(2)
      : configuredArgv;
    if (argv.length !== 0) throw new Error('invalid arguments');

    const configuredEnv = options.env;
    const env = configuredEnv === undefined ? process.env : configuredEnv;
    const environment = parseIdentityCompatibilityEnvironment(env);

    const configuredConfigPath = options.configPath;
    const configPath = configuredConfigPath === undefined
      ? 'wrangler.toml'
      : configuredConfigPath;
    const configuredReadBinding = options.readBinding;
    const readBinding = configuredReadBinding === undefined
      ? readProductionD1Binding
      : configuredReadBinding;
    const binding = readBinding({ configPath, binding: 'DB' });
    assertExactBinding(binding);

    const configuredCreateClient = options.createClient;
    const createClient = configuredCreateClient === undefined
      ? createCloudflareD1RestClient
      : configuredCreateClient;
    const client = createClient({
      accountId: environment.accountId,
      apiToken: environment.readToken,
    });
    assertIdentityCompatibilityRemoteTarget(
      await client.listDatabasesByExactName('hereisorder'),
      binding,
    );
    assertReadOnlyIdentityAuditSql(IDENTITY_COMPATIBILITY_SQL);
    const row = parseIdentityCompatibilityResult(await client.query(
      binding.databaseId,
      { sql: IDENTITY_COMPATIBILITY_SQL },
    ));

    const configuredNow = options.now;
    const now = configuredNow === undefined ? () => new Date() : configuredNow;
    const executedAt = now().toISOString();

    const configuredRandomUUID = options.randomUUID;
    const randomUUID = configuredRandomUUID === undefined
      ? createRandomUUID
      : configuredRandomUUID;
    const requestId = randomUUID();
    const report = buildIdentityCompatibilityReport({
      row,
      executedAt,
      gitSha: environment.gitSha,
      requestId,
    });

    const configuredAppendSummary = options.appendSummary;
    const appendSummary = configuredAppendSummary === undefined
      ? (filePath, contents) => fs.appendFileSync(filePath, contents, 'utf8')
      : configuredAppendSummary;
    await appendSummary(
      environment.summaryPath,
      renderIdentityCompatibilitySummary(report),
    );

    const configuredLog = options.log;
    const log = configuredLog === undefined
      ? (contents) => console.log(contents)
      : configuredLog;
    await log(JSON.stringify(report));
    return Object.freeze({
      report,
      gatePassed: identityCompatibilityGatePassed(report),
    });
  } catch {
    throw new Error('Identity compatibility audit failed.');
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runIdentityCompatibilityAudit()
    .then(({ gatePassed }) => {
      if (!gatePassed) process.exitCode = 1;
    })
    .catch(() => {
      console.error('Identity compatibility audit failed.');
      process.exitCode = 1;
    });
}
