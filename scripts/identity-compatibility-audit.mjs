import fs from 'node:fs';

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
const MUTATING_SQL_KEYWORD = new RegExp(
  '\\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|TRIGGER)\\b',
  'i',
);
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
