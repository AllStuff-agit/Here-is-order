import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IDENTITY_COMPATIBILITY_AUDIT_VERSION,
  IDENTITY_COMPATIBILITY_SQL,
  assertReadOnlyIdentityAuditSql,
  buildIdentityCompatibilityReport,
  identityCompatibilityGatePassed,
  parseIdentityCompatibilityResult,
  renderIdentityCompatibilitySummary,
} from './identity-compatibility-audit.mjs';

const QUERY_FIELDS = [
  'audit_version',
  'legacy_password_hash_count',
  'unsupported_password_hash_count',
  'invalid_identity_projection_count',
];
const REPORT_INPUT_FIELDS = [
  'row',
  'executedAt',
  'gitSha',
  'requestId',
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

const cleanRow = {
  audit_version: 'identity-compatibility-v1',
  legacy_password_hash_count: 3,
  unsupported_password_hash_count: 0,
  invalid_identity_projection_count: 0,
};
const cleanEnvelope = [{ success: true, results: [cleanRow], meta: {} }];
const reportInput = {
  row: cleanRow,
  executedAt: '2026-07-15T12:34:56.000Z',
  gitSha: 'a'.repeat(40),
  requestId: '123e4567-e89b-42d3-a456-426614174000',
};
const expectedReport = {
  auditVersion: 'identity-compatibility-v1',
  executedAt: '2026-07-15T12:34:56.000Z',
  gitSha: 'a'.repeat(40),
  requestId: '123e4567-e89b-42d3-a456-426614174000',
  legacyPasswordHashCount: 3,
  unsupportedPasswordHashCount: 0,
  invalidIdentityProjectionCount: 0,
  outcome: 'verified',
};

function envelope(row = cleanRow) {
  return [{ success: true, results: [row], meta: {} }];
}

function without(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

function collisionCandidate(values, fieldNames, storage) {
  const candidate = storage === 'inherited'
    ? Object.create(values)
    : Object.create(null);
  if (storage === 'non-enumerable') {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(candidate, key, {
        configurable: true,
        enumerable: false,
        value,
      });
    }
  }
  Object.defineProperty(candidate, [...fieldNames].sort().join(','), {
    configurable: true,
    enumerable: true,
    value: 'enumerable key collision',
  });
  return candidate;
}

test('exports the fixed version and accepts its checked-in read-only SQL', () => {
  assert.equal(IDENTITY_COMPATIBILITY_AUDIT_VERSION, 'identity-compatibility-v1');
  assert.equal(typeof IDENTITY_COMPATIBILITY_SQL, 'string');
  assert.match(IDENTITY_COMPATIBILITY_SQL, /^WITH constants AS \(/);
  assert.doesNotThrow(() => assertReadOnlyIdentityAuditSql(IDENTITY_COMPATIBILITY_SQL));
});

test('read-only SQL classification ignores comments and literals but rejects mutations', () => {
  for (const sql of [
    "WITH words AS (SELECT 'DELETE; PRAGMA ''DROP''' AS word) SELECT word FROM words;",
    "/* UPDATE users */ SELECT '-- INSERT INTO users; VACUUM' AS text; -- ALTER users",
    "SELECT 'it''s a REPLACE; statement' AS text;",
  ]) {
    assert.doesNotThrow(() => assertReadOnlyIdentityAuditSql(sql));
  }

  for (const keyword of [
    'INSERT',
    'UPDATE',
    'DELETE',
    'REPLACE',
    'CREATE',
    'ALTER',
    'DROP',
    'ATTACH',
    'DETACH',
    'PRAGMA',
    'VACUUM',
    'REINDEX',
    'TRIGGER',
  ]) {
    assert.throws(
      () => assertReadOnlyIdentityAuditSql(
        `WITH safe AS (SELECT 1) SELECT * FROM safe ${keyword}`,
      ),
      /read-only/i,
      `${keyword} must be rejected outside a literal`,
    );
  }
});

test('read-only SQL classification requires exactly one complete WITH or SELECT statement', () => {
  for (const sql of [
    '',
    ';',
    'VALUES (1);',
    'EXPLAIN SELECT 1;',
    'SELECT 1; SELECT 2;',
    "SELECT ';' AS value; SELECT 2;",
    "SELECT 'unterminated",
    'SELECT 1 /* unterminated',
  ]) {
    assert.throws(() => assertReadOnlyIdentityAuditSql(sql), /read-only/i);
  }
});

test('parses exactly one successful D1 result containing one exact row', () => {
  assert.deepEqual(parseIdentityCompatibilityResult(cleanEnvelope), cleanRow);
  assert.deepEqual(Object.keys(parseIdentityCompatibilityResult(cleanEnvelope)), QUERY_FIELDS);
});

test('rejects missing or extra D1 results and rows', () => {
  const invalidResults = [
    undefined,
    null,
    {},
    [],
    [
      { success: true, results: [cleanRow], meta: {} },
      { success: true, results: [cleanRow], meta: {} },
    ],
    [{ success: false, results: [cleanRow], meta: {} }],
    [{ success: 'true', results: [cleanRow], meta: {} }],
    [{ success: true, meta: {} }],
    [{ success: true, results: null, meta: {} }],
    [{ success: true, results: [], meta: {} }],
    [{ success: true, results: [cleanRow, cleanRow], meta: {} }],
  ];

  for (const value of invalidResults) {
    assert.throws(() => parseIdentityCompatibilityResult(value));
  }
});

test('rejects missing, extra, reordered, and wrong-version query fields', () => {
  for (const field of QUERY_FIELDS) {
    assert.throws(() => parseIdentityCompatibilityResult(envelope(without(cleanRow, field))));
  }
  assert.throws(() => parseIdentityCompatibilityResult(envelope({
    ...cleanRow,
    user_id: 7,
  })));
  assert.throws(() => parseIdentityCompatibilityResult(envelope({
    legacy_password_hash_count: cleanRow.legacy_password_hash_count,
    audit_version: cleanRow.audit_version,
    unsupported_password_hash_count: cleanRow.unsupported_password_hash_count,
    invalid_identity_projection_count: cleanRow.invalid_identity_projection_count,
  })));
  assert.throws(() => parseIdentityCompatibilityResult(envelope({
    ...cleanRow,
    audit_version: 'identity-compatibility-v2',
  })));
});

test('rejects booleans, numeric strings, negative, fractional, and non-safe counts', () => {
  const invalidCounts = [
    false,
    true,
    '0',
    null,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ];
  for (const field of QUERY_FIELDS.slice(1)) {
    for (const value of invalidCounts) {
      const row = { ...cleanRow, [field]: value };
      assert.throws(() => parseIdentityCompatibilityResult(envelope(row)));
      assert.throws(() => buildIdentityCompatibilityReport({ ...reportInput, row }));
    }
  }
});

test('builds a new frozen report with the exact ordered evidence fields', () => {
  assert.deepEqual(buildIdentityCompatibilityReport(reportInput), expectedReport);
  const report = buildIdentityCompatibilityReport(reportInput);
  assert.deepEqual(Object.keys(report), REPORT_FIELDS);
  assert.equal(Object.isFrozen(report), true);
  assert.notEqual(report, reportInput);
  assert.throws(() => {
    report.outcome = 'tampered';
  }, TypeError);
});

test('rejects missing or extra build input and malformed ISO, SHA, or UUID evidence', () => {
  for (const field of REPORT_INPUT_FIELDS) {
    assert.throws(() => buildIdentityCompatibilityReport(without(reportInput, field)));
  }
  assert.throws(() => buildIdentityCompatibilityReport({ ...reportInput, databaseId: 'forbidden' }));

  for (const executedAt of [
    '2026-07-15T12:34:56Z',
    '2026-07-15T12:34:56.000+00:00',
    '2026-02-30T12:34:56.000Z',
    '2026-07-15T12:34:56.000Z ',
    0,
  ]) {
    assert.throws(() => buildIdentityCompatibilityReport({ ...reportInput, executedAt }));
  }
  for (const gitSha of [
    'a'.repeat(39),
    'a'.repeat(41),
    'A'.repeat(40),
    `${'a'.repeat(39)}g`,
    7,
  ]) {
    assert.throws(() => buildIdentityCompatibilityReport({ ...reportInput, gitSha }));
  }
  for (const requestId of [
    '123e4567-e89b-12d3-a456-426614174000',
    '123e4567-e89b-42d3-7456-426614174000',
    '123E4567-E89B-42D3-A456-426614174000',
    '123e4567e89b42d3a456426614174000',
    7,
  ]) {
    assert.throws(() => buildIdentityCompatibilityReport({ ...reportInput, requestId }));
  }
});

test('the gate ignores legacy count but fails closed on unsupported or invalid projection counts', () => {
  assert.equal(identityCompatibilityGatePassed(buildIdentityCompatibilityReport(reportInput)), true);
  assert.equal(identityCompatibilityGatePassed(buildIdentityCompatibilityReport({
    ...reportInput,
    row: { ...cleanRow, unsupported_password_hash_count: 1 },
  })), false);
  assert.equal(identityCompatibilityGatePassed(buildIdentityCompatibilityReport({
    ...reportInput,
    row: { ...cleanRow, invalid_identity_projection_count: 1 },
  })), false);
});

test('renders only the exact ordered report JSON summary', () => {
  const report = buildIdentityCompatibilityReport(reportInput);
  assert.equal(
    renderIdentityCompatibilitySummary(report),
    `## Identity compatibility audit\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
  );
});

test('rejects extra, missing, malformed, or reordered rendered report fields', () => {
  const report = buildIdentityCompatibilityReport(reportInput);
  const invalidReports = [
    { ...report, databaseId: 'forbidden' },
    without(report, 'requestId'),
    { ...report, auditVersion: 'identity-compatibility-v2' },
    { ...report, outcome: 'failed' },
    { ...report, unsupportedPasswordHashCount: '0' },
    { ...report, invalidIdentityProjectionCount: -1 },
  ];
  for (const invalidReport of invalidReports) {
    assert.throws(() => identityCompatibilityGatePassed(invalidReport));
    assert.throws(() => renderIdentityCompatibilitySummary(invalidReport));
  }

  const entries = Object.entries(report);
  for (let index = 0; index < entries.length - 1; index += 1) {
    const reorderedEntries = [...entries];
    [reorderedEntries[index], reorderedEntries[index + 1]] = [
      reorderedEntries[index + 1],
      reorderedEntries[index],
    ];
    const reordered = Object.fromEntries(reorderedEntries);
    assert.throws(
      () => renderIdentityCompatibilitySummary(reordered),
      undefined,
      `swapping report fields ${index} and ${index + 1} must fail`,
    );
  }
});

test('rejects inherited, non-enumerable, collision, symbol, and accessor property tricks', () => {
  const report = buildIdentityCompatibilityReport(reportInput);
  const ownRowWithInheritedExtra = Object.assign(
    Object.create({ user_id: 7 }),
    cleanRow,
  );
  const ownInputWithInheritedExtra = Object.assign(
    Object.create({ databaseId: 'forbidden' }),
    reportInput,
  );
  const ownReportWithInheritedExtra = Object.assign(
    Object.create({ toJSON: () => ({ leaked: true }) }),
    report,
  );

  const rowWithSymbol = { ...cleanRow };
  Object.defineProperty(rowWithSymbol, Symbol('user_id'), {
    enumerable: true,
    value: 7,
  });
  const inputWithAccessor = { ...reportInput };
  Object.defineProperty(inputWithAccessor, 'executedAt', {
    configurable: true,
    enumerable: true,
    get: () => reportInput.executedAt,
  });

  for (const row of [
    ownRowWithInheritedExtra,
    rowWithSymbol,
    collisionCandidate(cleanRow, QUERY_FIELDS, 'inherited'),
    collisionCandidate(cleanRow, QUERY_FIELDS, 'non-enumerable'),
  ]) {
    assert.throws(() => parseIdentityCompatibilityResult(envelope(row)));
  }
  for (const input of [
    ownInputWithInheritedExtra,
    inputWithAccessor,
    collisionCandidate(reportInput, REPORT_INPUT_FIELDS, 'inherited'),
    collisionCandidate(reportInput, REPORT_INPUT_FIELDS, 'non-enumerable'),
  ]) {
    assert.throws(() => buildIdentityCompatibilityReport(input));
  }
  for (const candidate of [
    ownReportWithInheritedExtra,
    collisionCandidate(report, REPORT_FIELDS, 'inherited'),
    collisionCandidate(report, REPORT_FIELDS, 'non-enumerable'),
  ]) {
    assert.throws(() => identityCompatibilityGatePassed(candidate));
    assert.throws(() => renderIdentityCompatibilitySummary(candidate));
  }
});
