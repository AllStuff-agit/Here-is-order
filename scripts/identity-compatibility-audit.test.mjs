import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  IDENTITY_COMPATIBILITY_AUDIT_VERSION,
  IDENTITY_COMPATIBILITY_SQL,
  assertIdentityCompatibilityRemoteTarget,
  assertReadOnlyIdentityAuditSql,
  buildIdentityCompatibilityReport,
  identityCompatibilityGatePassed,
  parseIdentityCompatibilityEnvironment,
  parseIdentityCompatibilityResult,
  renderIdentityCompatibilitySummary,
  runIdentityCompatibilityAudit,
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
const validEnvironment = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_STEP_SUMMARY: '/tmp/identity-summary.md',
  CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32),
  CLOUDFLARE_D1_READ_TOKEN: 'dedicated-read-token',
};
const productionBinding = {
  binding: 'DB',
  databaseName: 'hereisorder',
  databaseId: '6129977e-f5a1-41ee-96ce-7a7a1e260e6d',
};
const generatedRequestId = '123e4567-e89b-42d3-a456-426614174000';
const executedAt = '2026-07-15T12:34:56.000Z';
const AUDIT_MODULE_URL = new URL('./identity-compatibility-audit.mjs', import.meta.url);
const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

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

function createAuditHarness({ row = cleanRow } = {}) {
  const events = [];
  const client = {
    async listDatabasesByExactName(name) {
      events.push(['listDatabasesByExactName', name]);
      return [{ name: 'hereisorder', uuid: productionBinding.databaseId }];
    },
    async query(databaseId, body) {
      events.push(['query', databaseId, body]);
      return envelope(row);
    },
  };
  const deps = {
    argv: [],
    env: { ...validEnvironment },
    configPath: '/repo/wrangler.toml',
    readBinding(options) {
      events.push(['readBinding', options]);
      return { ...productionBinding };
    },
    createClient(options) {
      events.push(['createClient', options]);
      return client;
    },
    now() {
      events.push(['now']);
      return new Date(executedAt);
    },
    randomUUID() {
      events.push(['randomUUID']);
      return generatedRequestId;
    },
    async appendSummary(filePath, contents) {
      events.push(['appendSummary', filePath, contents]);
    },
    async log(contents) {
      events.push(['log', contents]);
    },
  };
  return { client, deps, events };
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

test('accepts only the protected main workflow environment and returns its safe fields', () => {
  const parsed = parseIdentityCompatibilityEnvironment(validEnvironment);
  assert.deepEqual(parsed, {
    accountId: validEnvironment.CLOUDFLARE_ACCOUNT_ID,
    readToken: validEnvironment.CLOUDFLARE_D1_READ_TOKEN,
    gitSha: validEnvironment.GITHUB_SHA,
    summaryPath: validEnvironment.GITHUB_STEP_SUMMARY,
  });
  assert.equal(Object.isFrozen(parsed), true);
});

test('rejects every missing protected workflow environment field', () => {
  for (const field of Object.keys(validEnvironment)) {
    assert.throws(
      () => parseIdentityCompatibilityEnvironment(without(validEnvironment, field)),
      /environment was invalid/i,
      `${field} must be required`,
    );
  }
});

test('rejects malformed protected workflow metadata and dedicated credentials', () => {
  const invalidPatches = [
    { CI: '1' },
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_SHA: 'A'.repeat(40) },
    { GITHUB_SHA: 'a'.repeat(39) },
    { GITHUB_RUN_ID: '0' },
    { GITHUB_RUN_ID: '01' },
    { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_RUN_ATTEMPT: '1.0' },
    { GITHUB_STEP_SUMMARY: 'tmp/identity-summary.md' },
    { GITHUB_STEP_SUMMARY: '/tmp/../identity-summary.md' },
    { GITHUB_STEP_SUMMARY: '/tmp/identity-summary.md\nleak' },
    { CLOUDFLARE_ACCOUNT_ID: 'B'.repeat(32) },
    { CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(31) },
    { CLOUDFLARE_D1_READ_TOKEN: '' },
    { CLOUDFLARE_D1_READ_TOKEN: ' dedicated-read-token' },
    { CLOUDFLARE_D1_READ_TOKEN: 'dedicated-read-token\nleak' },
  ];
  for (const patch of invalidPatches) {
    assert.throws(
      () => parseIdentityCompatibilityEnvironment({ ...validEnvironment, ...patch }),
      /environment was invalid/i,
    );
  }
});

test('rejects deploy credentials and user-controlled audit inputs even when the read token exists', () => {
  for (const patch of [
    { CLOUDFLARE_API_TOKEN: 'deploy-token' },
    { CLOUDFLARE_FORWARD_DEPLOY_TOKEN: 'forward-deploy-token' },
    { INPUT_SQL: 'SELECT * FROM users' },
    { INPUT_DATABASE_ID: productionBinding.databaseId },
    { INPUT_USERNAME: 'target-user' },
    { INPUT_ROLE: 'admin' },
    { INPUT_ACTION: 'query' },
  ]) {
    assert.throws(
      () => parseIdentityCompatibilityEnvironment({ ...validEnvironment, ...patch }),
      /environment was invalid/i,
    );
  }
});

test('invalid argv is rejected before environment access, config read, or client creation', async () => {
  const events = [];
  const env = new Proxy({}, {
    get() {
      events.push('environment');
      throw new Error('raw environment detail');
    },
  });
  await assert.rejects(
    () => runIdentityCompatibilityAudit({
      argv: ['--sql', 'SELECT 1'],
      env,
      readBinding() {
        events.push('readBinding');
      },
      createClient() {
        events.push('createClient');
      },
    }),
    { message: 'Identity compatibility audit failed.' },
  );
  assert.deepEqual(events, []);
});

test('null dependency options fail with only the canonical sanitized message', async () => {
  await assert.rejects(
    () => runIdentityCompatibilityAudit(null),
    (error) => {
      assert.equal(error.message, 'Identity compatibility audit failed.');
      assert.doesNotMatch(error.message, /null|destructure|convert/i);
      return true;
    },
  );
});

test('a throwing argv option getter fails with only the canonical sanitized message', async () => {
  const rawDetail = 'raw argv getter detail';
  const options = {};
  Object.defineProperty(options, 'argv', {
    enumerable: true,
    get() {
      throw new Error(rawDetail);
    },
  });

  await assert.rejects(
    () => runIdentityCompatibilityAudit(options),
    (error) => {
      assert.equal(error.message, 'Identity compatibility audit failed.');
      assert.equal(error.message.includes(rawDetail), false);
      return true;
    },
  );
});

test('invalid argv stops before an env option getter can run', async () => {
  const events = [];
  const options = {};
  Object.defineProperties(options, {
    argv: {
      enumerable: true,
      get() {
        events.push('argv');
        return ['--sql', 'SELECT 1'];
      },
    },
    env: {
      enumerable: true,
      get() {
        events.push('env');
        throw new Error('raw env getter detail');
      },
    },
  });

  await assert.rejects(
    () => runIdentityCompatibilityAudit(options),
    { message: 'Identity compatibility audit failed.' },
  );
  assert.deepEqual(events, ['argv']);
});

test('invalid environment is rejected before config read or client creation', async () => {
  for (const env of [
    without(validEnvironment, 'CLOUDFLARE_D1_READ_TOKEN'),
    { ...validEnvironment, CLOUDFLARE_API_TOKEN: 'deploy-token' },
  ]) {
    const events = [];
    await assert.rejects(
      () => runIdentityCompatibilityAudit({
        argv: [],
        env,
        readBinding() {
          events.push('readBinding');
        },
        createClient() {
          events.push('createClient');
        },
      }),
      { message: 'Identity compatibility audit failed.' },
    );
    assert.deepEqual(events, []);
  }
});

test('requires the exact DB/hereisorder/canonical UUID binding before client creation', async () => {
  const invalidBindings = [
    { ...productionBinding, binding: 'OTHER' },
    { ...productionBinding, databaseName: 'hereisorder-preview' },
    { ...productionBinding, databaseId: productionBinding.databaseId.toUpperCase() },
    { ...productionBinding, databaseId: productionBinding.databaseId.replaceAll('-', '') },
    { ...productionBinding, databaseId: `${productionBinding.databaseId} ` },
    { ...productionBinding, extra: 'forbidden' },
    without(productionBinding, 'databaseId'),
  ];
  for (const binding of invalidBindings) {
    const events = [];
    await assert.rejects(
      () => runIdentityCompatibilityAudit({
        argv: [],
        env: { ...validEnvironment },
        readBinding(options) {
          events.push(['readBinding', options]);
          return binding;
        },
        createClient() {
          events.push(['createClient']);
        },
      }),
      { message: 'Identity compatibility audit failed.' },
    );
    assert.deepEqual(events, [[
      'readBinding',
      { configPath: 'wrangler.toml', binding: 'DB' },
    ]]);
  }
});

test('requires exactly one exact-name remote database match with the checked-in UUID', () => {
  assert.doesNotThrow(() => assertIdentityCompatibilityRemoteTarget(
    [{ name: 'hereisorder', uuid: productionBinding.databaseId }],
    productionBinding,
  ));

  const invalidMatches = [
    undefined,
    [],
    [
      { name: 'hereisorder', uuid: productionBinding.databaseId },
      { name: 'hereisorder', uuid: productionBinding.databaseId },
    ],
    [{ name: 'other', uuid: productionBinding.databaseId }],
    [{ name: 'hereisorder', uuid: '11111111-1111-1111-1111-111111111111' }],
    [{ name: 'hereisorder', uuid: productionBinding.databaseId, id: 7 }],
    [Object.assign(
      Object.create({ id: 7 }),
      { name: 'hereisorder', uuid: productionBinding.databaseId },
    )],
  ];
  for (const matches of invalidMatches) {
    assert.throws(
      () => assertIdentityCompatibilityRemoteTarget(matches, productionBinding),
      /remote target was invalid/i,
    );
  }
});

test('resolves and calls now before resolving and calling randomUUID', async () => {
  const { deps, events } = createAuditHarness();
  Object.defineProperties(deps, {
    now: {
      configurable: true,
      enumerable: true,
      get() {
        events.push('get now');
        return () => {
          events.push('call now');
          return new Date(executedAt);
        };
      },
    },
    randomUUID: {
      configurable: true,
      enumerable: true,
      get() {
        events.push('get randomUUID');
        return () => {
          events.push('call randomUUID');
          return generatedRequestId;
        };
      },
    },
  });

  await runIdentityCompatibilityAudit(deps);
  assert.deepEqual(
    events.filter((event) => typeof event === 'string'),
    ['get now', 'call now', 'get randomUUID', 'call randomUUID'],
  );
});

test('a throwing randomUUID getter is sanitized only after now has run', async () => {
  const { deps, events } = createAuditHarness();
  const rawDetail = 'raw randomUUID getter detail';
  Object.defineProperties(deps, {
    now: {
      configurable: true,
      enumerable: true,
      get() {
        events.push('get now');
        return () => {
          events.push('call now');
          return new Date(executedAt);
        };
      },
    },
    randomUUID: {
      configurable: true,
      enumerable: true,
      get() {
        events.push('get randomUUID');
        throw new Error(rawDetail);
      },
    },
  });

  await assert.rejects(
    () => runIdentityCompatibilityAudit(deps),
    (error) => {
      assert.equal(error.message, 'Identity compatibility audit failed.');
      assert.equal(error.message.includes(rawDetail), false);
      return true;
    },
  );
  assert.deepEqual(
    events.filter((event) => typeof event === 'string'),
    ['get now', 'call now', 'get randomUUID'],
  );
});

test('runs the fixed audit in exact order and emits only summary then one-line report JSON', async () => {
  const { deps, events } = createAuditHarness();
  const result = await runIdentityCompatibilityAudit(deps);
  assert.deepEqual(result, { report: expectedReport, gatePassed: true });
  assert.equal(Object.isFrozen(result), true);
  assert.notEqual(result.report, expectedReport);
  assert.equal(Object.isFrozen(result.report), true);
  assert.deepEqual(events, [
    ['readBinding', { configPath: '/repo/wrangler.toml', binding: 'DB' }],
    ['createClient', {
      accountId: validEnvironment.CLOUDFLARE_ACCOUNT_ID,
      apiToken: validEnvironment.CLOUDFLARE_D1_READ_TOKEN,
    }],
    ['listDatabasesByExactName', 'hereisorder'],
    ['query', productionBinding.databaseId, { sql: IDENTITY_COMPATIBILITY_SQL }],
    ['now'],
    ['randomUUID'],
    [
      'appendSummary',
      validEnvironment.GITHUB_STEP_SUMMARY,
      renderIdentityCompatibilitySummary(result.report),
    ],
    ['log', JSON.stringify(result.report)],
  ]);
  assert.doesNotMatch(events.at(-1)[1], /\r|\n/);

  const output = `${events.at(-2)[2]}${events.at(-1)[1]}`;
  for (const forbidden of [
    validEnvironment.CLOUDFLARE_D1_READ_TOKEN,
    validEnvironment.CLOUDFLARE_ACCOUNT_ID,
    productionBinding.databaseId,
    'audit_version',
    'password_hash',
    'results',
    'success',
    'meta',
  ]) {
    assert.equal(output.includes(forbidden), false);
  }
});

test('returns a frozen failed gate only after emitting the same safe eight-field report', async () => {
  const { deps, events } = createAuditHarness({
    row: {
      ...cleanRow,
      unsupported_password_hash_count: 1,
      invalid_identity_projection_count: 2,
    },
  });
  const result = await runIdentityCompatibilityAudit(deps);
  assert.equal(result.gatePassed, false);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Object.keys(result.report), REPORT_FIELDS);
  assert.deepEqual(result.report, {
    ...expectedReport,
    unsupportedPasswordHashCount: 1,
    invalidIdentityProjectionCount: 2,
  });
  assert.deepEqual(events.slice(-2).map((event) => event[0]), [
    'appendSummary',
    'log',
  ]);
  assert.equal(events.at(-1)[1], JSON.stringify(result.report));
});

test('sanitizes every dependency failure without leaking target, envelope, or raw detail', async () => {
  const rawDetail = [
    'raw-detail',
    validEnvironment.CLOUDFLARE_D1_READ_TOKEN,
    validEnvironment.CLOUDFLARE_ACCOUNT_ID,
    productionBinding.databaseId,
    JSON.stringify(cleanEnvelope),
  ].join('/');
  const failures = [
    { key: 'readBinding', replacement() { throw new Error(rawDetail); } },
    { key: 'createClient', replacement() { throw new Error(rawDetail); } },
    {
      key: 'createClient',
      replacement() {
        return {
          async listDatabasesByExactName() { throw new Error(rawDetail); },
        };
      },
    },
    {
      key: 'createClient',
      replacement() {
        return {
          async listDatabasesByExactName() {
            return [{ name: 'hereisorder', uuid: productionBinding.databaseId }];
          },
          async query() { throw new Error(rawDetail); },
        };
      },
    },
    { key: 'now', replacement() { throw new Error(rawDetail); } },
    { key: 'randomUUID', replacement() { throw new Error(rawDetail); } },
    { key: 'appendSummary', async replacement() { throw new Error(rawDetail); } },
    { key: 'log', async replacement() { throw new Error(rawDetail); } },
  ];

  for (const { key, replacement } of failures) {
    const { deps } = createAuditHarness();
    deps[key] = replacement;
    await assert.rejects(
      () => runIdentityCompatibilityAudit(deps),
      (error) => {
        assert.equal(error.message, 'Identity compatibility audit failed.');
        assert.equal(error.message.includes(rawDetail), false);
        return true;
      },
    );
  }
});

test('the zero-input CLI prints only the sanitized failure and exits nonzero', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(AUDIT_MODULE_URL)], {
    encoding: 'utf8',
    env: {},
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Identity compatibility audit failed.\n');
});

test('the direct-entry CLI invokes once, emits one safe failed-gate report, and exits nonzero', () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'identity-compatibility-cli-'),
  );
  const preloadPath = path.join(temporaryDirectory, 'fake-cloudflare.mjs');
  const summaryPath = path.join(temporaryDirectory, 'summary.md');
  const listUrl = `https://api.cloudflare.com/client/v4/accounts/${
    validEnvironment.CLOUDFLARE_ACCOUNT_ID
  }/d1/database?name=hereisorder`;
  const queryUrl = `https://api.cloudflare.com/client/v4/accounts/${
    validEnvironment.CLOUDFLARE_ACCOUNT_ID
  }/d1/database/${productionBinding.databaseId}/query`;
  const preloadSource = `
let requestCount = 0;
globalThis.fetch = async (url, init) => {
  requestCount += 1;
  if (requestCount === 1) {
    if (url !== ${JSON.stringify(listUrl)}
      || init.method !== 'GET'
      || init.headers.Authorization !== ${JSON.stringify(
    `Bearer ${validEnvironment.CLOUDFLARE_D1_READ_TOKEN}`,
  )}) {
      throw new Error('invalid list request');
    }
    return new Response(JSON.stringify({
      success: true,
      result: [{
        name: 'hereisorder',
        uuid: ${JSON.stringify(productionBinding.databaseId)},
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (requestCount === 2) {
    const body = JSON.parse(init.body);
    if (url !== ${JSON.stringify(queryUrl)}
      || init.method !== 'POST'
      || Object.keys(body).join(',') !== 'sql'
      || typeof body.sql !== 'string'
      || !body.sql.startsWith('WITH constants AS (')) {
      throw new Error('invalid query request');
    }
    return new Response(JSON.stringify({
      success: true,
      result: [{
        success: true,
        results: [{
          audit_version: 'identity-compatibility-v1',
          legacy_password_hash_count: 3,
          unsupported_password_hash_count: 1,
          invalid_identity_projection_count: 2,
        }],
        meta: {},
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('audit invoked more than once');
};
process.on('beforeExit', () => {
  if (requestCount !== 2) process.exitCode = 92;
});
`;

  try {
    fs.writeFileSync(preloadPath, preloadSource, 'utf8');
    const result = spawnSync(process.execPath, [
      '--import',
      pathToFileURL(preloadPath).href,
      fileURLToPath(AUDIT_MODULE_URL),
    ], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: { ...validEnvironment, GITHUB_STEP_SUMMARY: summaryPath },
    });

    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^\{[^\r\n]+\}\n$/);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(report), REPORT_FIELDS);
    assert.equal(report.auditVersion, IDENTITY_COMPATIBILITY_AUDIT_VERSION);
    assert.match(report.executedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(report.gitSha, validEnvironment.GITHUB_SHA);
    assert.match(
      report.requestId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(report.legacyPasswordHashCount, 3);
    assert.equal(report.unsupportedPasswordHashCount, 1);
    assert.equal(report.invalidIdentityProjectionCount, 2);
    assert.equal(report.outcome, 'verified');

    const summary = fs.readFileSync(summaryPath, 'utf8');
    assert.equal(summary, renderIdentityCompatibilitySummary(report));
    assert.equal(summary.split('## Identity compatibility audit').length - 1, 1);
    for (const forbidden of [
      validEnvironment.CLOUDFLARE_D1_READ_TOKEN,
      validEnvironment.CLOUDFLARE_ACCOUNT_ID,
      productionBinding.databaseId,
      'audit_version',
      'password_hash',
      'results',
      'success',
      'meta',
      'Identity compatibility audit failed.',
    ]) {
      assert.equal(`${result.stdout}${result.stderr}${summary}`.includes(forbidden), false);
    }
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
