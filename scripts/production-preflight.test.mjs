import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APPLIED_MIGRATIONS_SQL,
  PREFLIGHT_VERSION,
  buildPreflightReport,
  findPendingMigrations,
  parseActiveDeployment,
  parseAppliedMigrationResult,
  readActiveWorkerDeployment,
  readMigrationManifest,
  renderPreflightSummary,
  runProductionPreflight,
} from './production-preflight.mjs';

const ACCOUNT_ID = 'sensitive-account-id';
const API_TOKEN = 'sensitive-api-token';
const DATABASE_ID = '6129977e-f5a1-41ee-96ce-7a7a1e260e6d';
const API_DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111';
const API_VERSION_ID = '22222222-2222-4222-8222-222222222222';
const WEB_DEPLOYMENT_ID = '33333333-3333-4333-8333-333333333333';
const WEB_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const GIT_SHA = 'a'.repeat(40);
const BOOKMARK = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
const EXECUTED_AT = '2026-07-13T16:00:00.000Z';
const LOCAL_MIGRATIONS = ['001_init.sql', '002_integrity_and_roles.sql'];
const APPLIED_ROWS = [
  { id: 1, name: '001_init.sql', applied_at: '2026-07-11 10:00:00' },
  { id: 2, name: '002_integrity_and_roles.sql', applied_at: '2026-07-12 11:22:33' },
];

function queryResult(rows = APPLIED_ROWS) {
  return [{ success: true, results: rows, meta: {} }];
}

function deployment({
  deploymentId = API_DEPLOYMENT_ID,
  versionId = API_VERSION_ID,
  createdOn = '2026-07-13T14:00:00.123456Z',
  percentage = 100,
  extra = {},
} = {}) {
  return {
    id: deploymentId,
    created_on: createdOn,
    source: 'wrangler',
    author_email: 'sensitive-author@example.com',
    versions: [{ version_id: versionId, percentage }],
    ...extra,
  };
}

function activeDeployment({ web = false } = {}) {
  return {
    deploymentId: web ? WEB_DEPLOYMENT_ID : API_DEPLOYMENT_ID,
    createdOn: web
      ? '2026-07-13T14:01:00.123456Z'
      : '2026-07-13T14:00:00.123456Z',
    versions: [{
      versionId: web ? WEB_VERSION_ID : API_VERSION_ID,
      percentage: 100,
    }],
  };
}

function validEnv() {
  return {
    CI: 'true',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: GIT_SHA,
    GITHUB_RUN_ID: '29260000000',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_STEP_SUMMARY: '/tmp/hio-preflight-summary',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: API_TOKEN,
  };
}

test('readMigrationManifest는 safe SQL manifest를 number 순서로 고정한다', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-migrations-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, '002_second.sql'), '-- second');
  fs.writeFileSync(path.join(directory, '001_first.sql'), '-- first');

  assert.deepEqual(readMigrationManifest({ migrationsDir: directory }), [
    '001_first.sql',
    '002_second.sql',
  ]);
});

test('readMigrationManifest는 empty, unsafe, duplicate number manifest를 거부한다', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-migrations-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  assert.throws(() => readMigrationManifest({ migrationsDir: empty }), /migration manifest/);

  const unsafe = path.join(root, 'unsafe');
  fs.mkdirSync(unsafe);
  fs.writeFileSync(path.join(unsafe, 'migration.sql'), 'SELECT 1;');
  assert.throws(() => readMigrationManifest({ migrationsDir: unsafe }), /migration manifest/);

  const duplicate = path.join(root, 'duplicate');
  fs.mkdirSync(duplicate);
  fs.writeFileSync(path.join(duplicate, '001_first.sql'), 'SELECT 1;');
  fs.writeFileSync(path.join(duplicate, '001_second.sql'), 'SELECT 1;');
  assert.throws(() => readMigrationManifest({ migrationsDir: duplicate }), /migration manifest/);
});

test('parseAppliedMigrationResult는 D1 UTC timestamp와 contiguous rows만 허용한다', () => {
  assert.deepEqual(parseAppliedMigrationResult(queryResult()), APPLIED_ROWS);
});

test('parseAppliedMigrationResult는 malformed query/row/time/order를 거부한다', () => {
  const invalid = [
    [],
    [{ success: true, results: [] }, { success: true, results: [] }],
    [{ success: false, results: APPLIED_ROWS }],
    [{ success: true, results: null }],
    queryResult([{ ...APPLIED_ROWS[0], extra: 'row-data' }]),
    queryResult([{ ...APPLIED_ROWS[0], id: 2 }]),
    queryResult([{ ...APPLIED_ROWS[0], name: '../001.sql' }]),
    queryResult([{ ...APPLIED_ROWS[0], applied_at: '2026-07-11T10:00:00Z' }]),
    queryResult([{ ...APPLIED_ROWS[0], applied_at: '2026-02-31 10:00:00' }]),
    queryResult([APPLIED_ROWS[0], { ...APPLIED_ROWS[1], name: APPLIED_ROWS[0].name }]),
  ];
  for (const value of invalid) {
    assert.throws(() => parseAppliedMigrationResult(value), /applied migration/);
  }
});

test('findPendingMigrations는 production applied exact prefix만 허용한다', () => {
  assert.deepEqual(findPendingMigrations(LOCAL_MIGRATIONS, [APPLIED_ROWS[0]]), [
    '002_integrity_and_roles.sql',
  ]);
  assert.deepEqual(findPendingMigrations(LOCAL_MIGRATIONS, APPLIED_ROWS), []);
});

test('findPendingMigrations는 unknown/reordered/duplicated/longer production state를 거부한다', () => {
  const invalidApplied = [
    [{ ...APPLIED_ROWS[0], name: '999_unknown.sql' }],
    [APPLIED_ROWS[1], APPLIED_ROWS[0]],
    [APPLIED_ROWS[0], { ...APPLIED_ROWS[1], name: APPLIED_ROWS[0].name }],
    [...APPLIED_ROWS, { id: 3, name: '003_remote_only.sql', applied_at: '2026-07-13 12:00:00' }],
  ];
  for (const value of invalidApplied) {
    assert.throws(() => findPendingMigrations(LOCAL_MIGRATIONS, value), /migration divergence/);
  }
});

test('parseActiveDeployment는 newest deployment를 결정적으로 선택하고 allocation을 whitelist한다', () => {
  const older = deployment({
    deploymentId: '55555555-5555-4555-8555-555555555555',
    versionId: '66666666-6666-4666-8666-666666666666',
    createdOn: '2026-07-12T14:00:00Z',
  });
  const latest = deployment();
  const parsed = parseActiveDeployment({ deployments: [older, latest] });

  assert.deepEqual(parsed, activeDeployment());
  assert.equal(JSON.stringify(parsed).includes('sensitive-author'), false);
});

test('parseActiveDeployment는 같은 millisecond 안에서도 Cloudflare microseconds를 보존한다', () => {
  const older = deployment({
    deploymentId: '00000000-0000-4000-8000-000000000001',
    versionId: '66666666-6666-4666-8666-666666666666',
    createdOn: '2026-07-13T14:00:00.123455Z',
  });
  const latest = deployment({ createdOn: '2026-07-13T14:00:00.123456Z' });

  assert.deepEqual(
    parseActiveDeployment({ deployments: [older, latest] }),
    activeDeployment(),
  );
});

test('parseActiveDeployment는 historical split은 허용하고 malformed history는 거부한다', () => {
  const historicalSplit = deployment({
    deploymentId: '55555555-5555-4555-8555-555555555555',
    createdOn: '2026-07-12T14:00:00Z',
    extra: {
      versions: [
        { version_id: '66666666-6666-4666-8666-666666666666', percentage: 50 },
        { version_id: '77777777-7777-4777-8777-777777777777', percentage: 50 },
      ],
    },
  });
  assert.deepEqual(
    parseActiveDeployment({ deployments: [historicalSplit, deployment()] }),
    activeDeployment(),
  );

  assert.throws(
    () => parseActiveDeployment({
      deployments: [{ ...historicalSplit, created_on: 'invalid' }, deployment()],
    }),
    /active Worker deployment/,
  );
});

test('parseActiveDeployment는 empty/malformed/split/non-100 deployment를 fail closed 한다', () => {
  const invalid = [
    null,
    {},
    { deployments: [] },
    { deployments: [null] },
    { deployments: [deployment({ deploymentId: 'not-a-uuid' })] },
    { deployments: [deployment({ versionId: 'not-a-uuid' })] },
    { deployments: [deployment({ createdOn: 'not-a-time' })] },
    { deployments: [deployment({ percentage: 99 })] },
    {
      deployments: [deployment({
        extra: {
          versions: [
            { version_id: API_VERSION_ID, percentage: 50 },
            { version_id: WEB_VERSION_ID, percentage: 50 },
          ],
        },
      })],
    },
  ];
  for (const value of invalid) {
    assert.throws(() => parseActiveDeployment(value), /active Worker deployment/);
  }
});

test('readActiveWorkerDeployment는 encoded fixed GET과 Bearer token만 사용한다', async () => {
  const requests = [];
  const workerName = 'hereisorder-web';
  const result = await readActiveWorkerDeployment({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    workerName,
    baseUrl: 'https://cloudflare.invalid/client/v4',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        success: true,
        result: { deployments: [deployment()] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.deepEqual(result, activeDeployment());
  assert.deepEqual(requests, [{
    url: `https://cloudflare.invalid/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${workerName}/deployments`,
    init: {
      method: 'GET',
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    },
  }]);
});

test('readActiveWorkerDeployment는 HTTP/envelope/JSON/transport detail을 sanitize한다', async () => {
  const sensitive = `${ACCOUNT_ID}/${API_TOKEN}/author@example.com/raw-detail`;
  const fetchCases = [
    async () => { throw new Error(sensitive); },
    async () => new Response(sensitive, { status: 200 }),
    async () => new Response(JSON.stringify({
      success: true,
      result: { deployments: [deployment()] },
    }), { status: 403 }),
    async () => new Response(JSON.stringify({
      success: false,
      errors: [{ message: sensitive }],
    }), { status: 200 }),
  ];
  for (const fetchImpl of fetchCases) {
    await assert.rejects(
      readActiveWorkerDeployment({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        workerName: 'hereisorder',
        fetchImpl,
      }),
      (error) => {
        assert.equal(error.message, 'Cloudflare Worker deployment request failed.');
        assert.doesNotMatch(error.message, /raw-detail|author/);
        assert.doesNotMatch(error.message, new RegExp(API_TOKEN));
        assert.doesNotMatch(error.message, new RegExp(ACCOUNT_ID));
        return true;
      },
    );
  }
});

test('buildPreflightReport는 strict whitelist report를 만든다', () => {
  const report = buildPreflightReport({
    executedAt: EXECUTED_AT,
    gitSha: GIT_SHA,
    runId: '29260000000',
    runAttempt: 1,
    databaseName: 'hereisorder',
    databaseId: DATABASE_ID,
    bookmark: BOOKMARK,
    appliedMigrations: LOCAL_MIGRATIONS,
    pendingMigrations: [],
    previousDeployments: {
      api: activeDeployment(),
      web: activeDeployment({ web: true }),
    },
  });

  assert.deepEqual(report, {
    preflightVersion: PREFLIGHT_VERSION,
    executedAt: EXECUTED_AT,
    gitSha: GIT_SHA,
    runId: '29260000000',
    runAttempt: 1,
    databaseName: 'hereisorder',
    databaseId: DATABASE_ID,
    bookmark: BOOKMARK,
    appliedMigrations: LOCAL_MIGRATIONS,
    pendingMigrations: [],
    previousDeployments: {
      api: activeDeployment(),
      web: activeDeployment({ web: true }),
    },
    outcome: 'ready',
  });
  assert.deepEqual(Object.keys(report), [
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
  ]);
  assert.match(renderPreflightSummary(report), /Production deployment checkpoint/);
  assert.match(renderPreflightSummary(report), new RegExp(BOOKMARK));
});

test('buildPreflightReport는 malformed metadata와 mutable inputs를 거부한다', () => {
  const base = {
    executedAt: EXECUTED_AT,
    gitSha: GIT_SHA,
    runId: '29260000000',
    runAttempt: 1,
    databaseName: 'hereisorder',
    databaseId: DATABASE_ID,
    bookmark: BOOKMARK,
    appliedMigrations: LOCAL_MIGRATIONS,
    pendingMigrations: [],
    previousDeployments: {
      api: activeDeployment(),
      web: activeDeployment({ web: true }),
    },
  };
  const invalid = [
    { gitSha: 'abc' },
    { runId: 'run-id' },
    { runAttempt: 0 },
    { databaseName: 'other' },
    { databaseId: 'not-a-uuid' },
    { bookmark: '../bookmark' },
    { appliedMigrations: ['../001.sql'] },
    { pendingMigrations: ['001_init.sql'] },
    { previousDeployments: { api: activeDeployment() } },
  ];
  for (const override of invalid) {
    assert.throws(() => buildPreflightReport({ ...base, ...override }), /preflight report/);
  }
});

test('buildPreflightReport와 summary는 caller mutation과 extra evidence를 차단한다', () => {
  const appliedMigrations = [...LOCAL_MIGRATIONS];
  const previousDeployments = {
    api: activeDeployment(),
    web: activeDeployment({ web: true }),
  };
  const report = buildPreflightReport({
    executedAt: EXECUTED_AT,
    gitSha: GIT_SHA,
    runId: '29260000000',
    runAttempt: 1,
    databaseName: 'hereisorder',
    databaseId: DATABASE_ID,
    bookmark: BOOKMARK,
    appliedMigrations,
    pendingMigrations: [],
    previousDeployments,
  });

  appliedMigrations[0] = '999_attacker.sql';
  previousDeployments.api.versions[0].versionId = WEB_VERSION_ID;
  assert.deepEqual(report.appliedMigrations, LOCAL_MIGRATIONS);
  assert.equal(report.previousDeployments.api.versions[0].versionId, API_VERSION_ID);
  assert.throws(
    () => renderPreflightSummary({ ...report, rawSecret: API_TOKEN }),
    /preflight report/,
  );
});

function successfulRunOptions(overrides = {}) {
  const calls = [];
  const summaries = [];
  const logs = [];
  const d1Client = {
    async listDatabasesByExactName(name) {
      calls.push(['list-databases', name]);
      return [{ name: 'hereisorder', uuid: DATABASE_ID }];
    },
    async getTimeTravelBookmark(databaseId) {
      calls.push(['bookmark', databaseId]);
      return BOOKMARK;
    },
    async query(databaseId, body) {
      calls.push(['query', databaseId, body]);
      return queryResult();
    },
  };
  const options = {
    env: validEnv(),
    now: () => new Date(EXECUTED_AT),
    readBinding: () => ({
      binding: 'DB',
      databaseName: 'hereisorder',
      databaseId: DATABASE_ID,
    }),
    readManifest: () => LOCAL_MIGRATIONS,
    createD1Client: () => d1Client,
    readDeployment: async ({ workerName }) => {
      calls.push(['deployment', workerName]);
      return activeDeployment({ web: workerName === 'hereisorder-web' });
    },
    appendSummary: (summaryPath, contents) => {
      calls.push(['summary', summaryPath]);
      summaries.push(contents);
    },
    log: (value) => {
      calls.push(['log']);
      logs.push(value);
    },
    ...overrides,
  };
  return { options, calls, summaries, logs, d1Client };
}

test('runProductionPreflight는 fixed read 순서 뒤 summary와 whitelist log만 기록한다', async () => {
  const { options, calls, summaries, logs } = successfulRunOptions();
  const report = await runProductionPreflight(options);

  assert.equal(report.outcome, 'ready');
  assert.deepEqual(calls, [
    ['list-databases', 'hereisorder'],
    ['bookmark', DATABASE_ID],
    ['query', DATABASE_ID, { sql: APPLIED_MIGRATIONS_SQL, params: [] }],
    ['deployment', 'hereisorder'],
    ['deployment', 'hereisorder-web'],
    ['summary', '/tmp/hio-preflight-summary'],
    ['log'],
  ]);
  assert.equal(summaries.length, 1);
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]), report);
  const evidence = `${summaries[0]}\n${logs[0]}`;
  assert.doesNotMatch(evidence, /sensitive-api-token|sensitive-account-id|author@example|raw-detail/);
  assert.doesNotMatch(evidence, /ordered_qty|username|session/);
});

test('runProductionPreflight는 workflow/credential/config identity를 fail closed 한다', async () => {
  const cases = [
    { name: 'non-CI', env: { ...validEnv(), CI: 'false' } },
    { name: 'pull request', env: { ...validEnv(), GITHUB_EVENT_NAME: 'pull_request' } },
    { name: 'non-main', env: { ...validEnv(), GITHUB_REF: 'refs/heads/feature' } },
    { name: 'missing token', env: { ...validEnv(), CLOUDFLARE_API_TOKEN: '' } },
    { name: 'blank token', env: { ...validEnv(), CLOUDFLARE_API_TOKEN: '   ' } },
    {
      name: 'unsafe run attempt',
      env: { ...validEnv(), GITHUB_RUN_ATTEMPT: '9007199254740992' },
    },
    { name: 'missing summary', env: { ...validEnv(), GITHUB_STEP_SUMMARY: '' } },
    {
      name: 'binding mismatch',
      readBinding: () => ({
        binding: 'DB', databaseName: 'other', databaseId: DATABASE_ID,
      }),
    },
  ];
  for (const scenario of cases) {
    const { options, calls, summaries, logs } = successfulRunOptions(scenario);
    await assert.rejects(
      runProductionPreflight(options),
      (error) => {
        assert.equal(error.message, 'Production deployment preflight failed.');
        return true;
      },
      scenario.name,
    );
    assert.equal(summaries.length, 0, scenario.name);
    assert.equal(logs.length, 0, scenario.name);
    if (scenario.env || scenario.readBinding) {
      assert.equal(calls.some(([name]) => name === 'query'), false, scenario.name);
    }
  }
});

test('runProductionPreflight는 remote identity/bookmark/migration/deployment 실패에서 ready를 남기지 않는다', async () => {
  const cases = [
    {
      name: 'database mismatch',
      createD1Client: () => ({
        async listDatabasesByExactName() {
          return [{ name: 'hereisorder', uuid: '99999999-9999-4999-8999-999999999999' }];
        },
      }),
    },
    {
      name: 'raw bookmark failure',
      createD1Client: () => ({
        async listDatabasesByExactName() {
          return [{ name: 'hereisorder', uuid: DATABASE_ID }];
        },
        async getTimeTravelBookmark() { throw new Error(`${API_TOKEN}/raw-detail`); },
      }),
    },
    {
      name: 'migration divergence',
      readManifest: () => ['001_init.sql'],
    },
    {
      name: 'API deployment failure',
      readDeployment: async ({ workerName }) => {
        if (workerName === 'hereisorder') throw new Error('sensitive-author@example.com');
        return activeDeployment({ web: true });
      },
    },
    {
      name: 'web deployment failure',
      readDeployment: async ({ workerName }) => {
        if (workerName === 'hereisorder-web') throw new Error('raw-web-detail');
        return activeDeployment();
      },
    },
  ];
  for (const scenario of cases) {
    const { options, summaries, logs } = successfulRunOptions(scenario);
    await assert.rejects(
      runProductionPreflight(options),
      (error) => {
        assert.equal(error.message, 'Production deployment preflight failed.');
        assert.doesNotMatch(error.message, /raw|sensitive|token|author/);
        return true;
      },
      scenario.name,
    );
    assert.deepEqual(summaries, [], scenario.name);
    assert.deepEqual(logs, [], scenario.name);
  }
});

test('summary writer failure는 ready log를 남기지 않는다', async () => {
  const { options, logs } = successfulRunOptions({
    appendSummary: () => { throw new Error('sensitive summary path'); },
  });
  await assert.rejects(
    runProductionPreflight(options),
    (error) => {
      assert.equal(error.message, 'Production deployment preflight failed.');
      assert.doesNotMatch(error.message, /sensitive|summary path/);
      return true;
    },
  );
  assert.deepEqual(logs, []);
});
