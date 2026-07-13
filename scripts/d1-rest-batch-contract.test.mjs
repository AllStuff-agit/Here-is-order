import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { runD1RestBatchContract as runD1RestBatchContractImplementation } from './d1-rest-batch-contract.mjs';

const EXPECTED_FAILURE_BATCH = {
  batch: [
    { sql: 'UPDATE contract_state SET value = 1 WHERE id = ?', params: ['1'] },
    {
      sql: 'INSERT INTO contract_guard(value) SELECT value FROM contract_state WHERE id = ?',
      params: ['1'],
    },
  ],
};

const EXPECTED_CONSTRAINT_FAILURE = {
  httpOk: false,
  httpStatus: 400,
  envelope: {
    success: false,
    errors: [{
      code: 7500,
      message: 'D1_ERROR: CHECK constraint failed: hio_rollback_guard: SQLITE_CONSTRAINT',
    }],
  },
};

const workflow = readFileSync(
  new URL('../.github/workflows/deploy-worker.yml', import.meta.url),
  'utf8',
);
const packageJson = JSON.parse(readFileSync(
  new URL('../package.json', import.meta.url),
  'utf8',
));

const DIRECT_CLEANUP_UUID = 'ca1f6a9d-06f3-4b85-a4c7-fef570d9ca42';
const LOOKUP_CLEANUP_UUID = '77d93f13-093f-442f-b5b4-4561b85b886a';
const TEMPORARY_DATABASE_UUID = 'c667fd1a-28d8-4d1a-934c-b20e942cf6c2';
const TEST_RANDOM_SUFFIX = '0123456789ab';
const SHORT_DATABASE_NAME = `hio-rb-123-1-${TEST_RANDOM_SUFFIX}`;
const LONG_DATABASE_NAME = `hio-rb-123456789-99-${TEST_RANDOM_SUFFIX}`;

function validContractQuery(body) {
  if (body.sql.startsWith('SELECT value')) {
    return [{ success: true, results: [{ value: 0 }], meta: {} }];
  }
  return [{ success: true, results: [], meta: {} }];
}

function createErrorWithCleanupUuid(uuid) {
  const error = new Error('Cloudflare D1 create response was invalid.');
  Object.defineProperty(error, 'cleanupUuid', { value: uuid });
  Object.defineProperty(error, 'mayHaveCreatedDatabase', { value: true });
  return error;
}

function createAmbiguousError() {
  const error = new Error('Cloudflare D1 request failed.');
  Object.defineProperty(error, 'mayHaveCreatedDatabase', { value: true });
  return error;
}

function createRetryableError(status) {
  const error = new Error('Cloudflare D1 request failed.');
  Object.defineProperty(error, 'retryable', { value: true });
  if (status !== undefined) {
    Object.defineProperty(error, 'httpStatus', { value: status });
  }
  return error;
}

function createNonRetryableError(status) {
  const error = new Error('Cloudflare D1 request failed.');
  if (status !== undefined) {
    Object.defineProperty(error, 'httpStatus', { value: status });
  }
  return error;
}

function runD1RestBatchContract(options) {
  return runD1RestBatchContractImplementation({
    randomSuffix: () => TEST_RANDOM_SUFFIX,
    ...options,
    client: {
      async listDatabasesByExactName() { return []; },
      ...options.client,
    },
  });
}

test('main push/dispatch deployment는 verify 뒤 remote rollback contract에 gate된다', () => {
  const contractJob = workflow.match(
    /^  d1-rest-batch-contract:\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:\n)/m,
  )?.[1];
  assert.ok(contractJob, 'd1-rest-batch-contract job must exist');
  assert.match(
    contractJob,
    /if: github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\)/,
  );
  assert.match(contractJob, /^    needs: verify$/m);
  assert.match(contractJob, /run: npm ci/);
  assert.match(contractJob, /run: npm run test:d1-rest-batch-contract/);
  assert.match(contractJob, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(contractJob, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.match(contractJob, /CONTRACT_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(contractJob, /CONTRACT_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);

  const deployApi = workflow.match(
    /^  deploy-api:\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:\n)/m,
  )?.[1];
  assert.ok(deployApi, 'deploy-api job must exist');
  assert.match(deployApi, /needs:\n\s+- verify\n\s+- d1-rest-batch-contract/);
  assert.match(deployApi, /Apply production D1 migrations/);
  assert.ok(
    workflow.indexOf('  verify:') < workflow.indexOf('  d1-rest-batch-contract:'),
  );
  assert.ok(
    workflow.indexOf('  d1-rest-batch-contract:') < workflow.indexOf('  deploy-api:'),
  );

  assert.equal(
    packageJson.scripts['db:recover-password'],
    'node scripts/recover-password.mjs',
  );
  assert.equal(
    packageJson.scripts['test:d1-rest-batch-contract'],
    'node scripts/d1-rest-batch-contract.mjs',
  );
});

test('remote failure batch rollback을 확인하고 disposable D1을 삭제한다', async () => {
  const deleted = [];
  const queryBodies = [];
  const failureBodies = [];
  let readinessAttempts = 0;
  let createdName;
  const client = {
    async createDatabase(name) {
      createdName = name;
      return { name, uuid: TEMPORARY_DATABASE_UUID };
    },
    async query(_databaseId, body) {
      queryBodies.push(body);
      if (body.sql.startsWith('CREATE TABLE contract_state')) {
        readinessAttempts += 1;
        if (readinessAttempts === 1) throw new Error('not ready');
      }
      if (body.sql.startsWith('SELECT value')) {
        return [{ success: true, results: [{ value: 0 }], meta: {} }];
      }
      return [{ success: true, results: [], meta: {} }];
    },
    async queryAllowingFailure(_databaseId, body) {
      failureBodies.push(body);
      return structuredClone(EXPECTED_CONSTRAINT_FAILURE);
    },
    async deleteDatabase(databaseId) { deleted.push(databaseId); },
  };
  const logs = [];

  await runD1RestBatchContract({
    client,
    runId: '1234567890123456789012345678901234567890',
    runAttempt: '99',
    sleep: async () => {},
    log: (message) => logs.push(message),
  });

  assert.equal(createdName.length <= 32, true);
  assert.equal(createdName, LONG_DATABASE_NAME);
  assert.equal(readinessAttempts, 2);
  assert.deepEqual(queryBodies.slice(0, 4), [
    {
      sql: 'CREATE TABLE contract_state(id INTEGER PRIMARY KEY, value INTEGER)',
      params: [],
    },
    {
      sql: 'CREATE TABLE contract_state(id INTEGER PRIMARY KEY, value INTEGER)',
      params: [],
    },
    {
      sql: 'CREATE TABLE contract_guard(value INTEGER CONSTRAINT hio_rollback_guard CHECK(value = 0))',
      params: [],
    },
    {
      sql: 'INSERT INTO contract_state(id, value) VALUES (?, ?)',
      params: ['1', '0'],
    },
  ]);
  assert.deepEqual(failureBodies, [EXPECTED_FAILURE_BATCH]);
  assert.deepEqual(queryBodies.at(-1), {
    sql: 'SELECT value FROM contract_state WHERE id = ?',
    params: ['1'],
  });
  assert.deepEqual(deleted, [TEMPORARY_DATABASE_UUID]);
  assert.deepEqual(logs, [
    `D1 REST batch rollback verified: ${createdName}/${TEMPORARY_DATABASE_UUID}`,
  ]);
});

test('failure batch가 모두 성공으로 보고되면 contract를 실패시키고 삭제한다', async () => {
  const deleted = [];
  let verificationQueries = 0;
  const client = {
    async createDatabase(name) { return { name, uuid: TEMPORARY_DATABASE_UUID }; },
    async query(_databaseId, body) {
      if (body.sql.startsWith('SELECT value')) verificationQueries += 1;
      return [{ success: true, results: [], meta: {} }];
    },
    async queryAllowingFailure() {
      return { httpOk: true, envelope: { success: true, result: [{ success: true }] } };
    },
    async deleteDatabase(databaseId) { deleted.push(databaseId); },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async () => {},
      log: () => assert.fail('must not log success'),
    }),
    /예상한 constraint 오류/,
  );
  assert.equal(verificationQueries, 0);
  assert.deepEqual(deleted, [TEMPORARY_DATABASE_UUID]);
});

const INVALID_FAILURE_EVIDENCE = [
  {
    name: 'generic HTTP 500',
    response: {
      ...EXPECTED_CONSTRAINT_FAILURE,
      httpStatus: 500,
    },
  },
  {
    name: 'generic HTTP 429',
    response: {
      ...EXPECTED_CONSTRAINT_FAILURE,
      httpStatus: 429,
    },
  },
  {
    name: 'top-level generic failure',
    response: {
      httpOk: false,
      httpStatus: 400,
      envelope: {
        success: false,
        errors: [{ code: 1000, message: 'generic request failure' }],
      },
    },
  },
  {
    name: 'empty failure result',
    response: {
      httpOk: true,
      httpStatus: 200,
      envelope: { success: true, result: [] },
    },
  },
  {
    name: 'malformed null statement result',
    response: {
      httpOk: true,
      httpStatus: 200,
      envelope: { success: true, result: [null] },
    },
  },
  {
    name: 'missing marker',
    response: {
      httpOk: false,
      httpStatus: 400,
      envelope: {
        success: false,
        errors: [{ code: 7500, message: 'D1 constraint failed' }],
      },
    },
  },
  {
    name: 'wrong marker',
    response: {
      httpOk: false,
      httpStatus: 400,
      envelope: {
        success: false,
        errors: [{ code: 7500, message: 'CHECK constraint failed: other_guard' }],
      },
    },
  },
  {
    name: 'marker prefix collision',
    response: {
      httpOk: false,
      httpStatus: 400,
      envelope: {
        success: false,
        errors: [{ code: 7500, message: 'CHECK failed: hio_rollback_guard_extra' }],
      },
    },
  },
  {
    name: 'string query code',
    response: {
      httpOk: false,
      httpStatus: 400,
      envelope: {
        success: false,
        errors: [{ code: '7500', message: 'CHECK failed: hio_rollback_guard' }],
      },
    },
  },
  {
    name: 'non-string message',
    response: {
      httpOk: false,
      httpStatus: 400,
      envelope: {
        success: false,
        errors: [{ code: 7500, message: null }],
      },
    },
  },
  {
    name: 'extra error evidence',
    response: {
      httpOk: false,
      httpStatus: 400,
      envelope: {
        success: false,
        errors: [
          { code: 7500, message: 'CHECK failed: hio_rollback_guard' },
          { code: 1000, message: 'unexpected extra failure' },
        ],
      },
    },
  },
  {
    name: 'missing numeric HTTP status',
    response: {
      httpOk: false,
      envelope: EXPECTED_CONSTRAINT_FAILURE.envelope,
    },
  },
  {
    name: 'string HTTP status',
    response: {
      httpOk: false,
      httpStatus: '400',
      envelope: EXPECTED_CONSTRAINT_FAILURE.envelope,
    },
  },
  {
    name: 'HTTP ok contradiction',
    response: {
      httpOk: true,
      httpStatus: 400,
      envelope: EXPECTED_CONSTRAINT_FAILURE.envelope,
    },
  },
];

for (const { name, response } of INVALID_FAILURE_EVIDENCE) {
  test(`${name} 응답은 rollback failure 증거가 아니며 D1을 삭제한다`, async () => {
    const deleted = [];
    const logs = [];
    let verificationQueries = 0;
    const client = {
      async createDatabase(databaseName) {
        return { name: databaseName, uuid: TEMPORARY_DATABASE_UUID };
      },
      async query(_databaseId, body) {
        if (body.sql.startsWith('SELECT value')) verificationQueries += 1;
        return [{ success: true, results: [{ value: 0 }], meta: {} }];
      },
      async queryAllowingFailure() { return structuredClone(response); },
      async deleteDatabase(databaseId) { deleted.push(databaseId); },
    };

    await assert.rejects(
      runD1RestBatchContract({
        client,
        runId: '123',
        runAttempt: '1',
        sleep: async () => {},
        log: (message) => logs.push(message),
      }),
      /예상한 constraint 오류/,
    );
    assert.equal(verificationQueries, 0);
    assert.deepEqual(logs, []);
    assert.deepEqual(deleted, [TEMPORARY_DATABASE_UUID]);
  });
}

test('rollback assertion이 실패해도 disposable D1을 삭제한다', async () => {
  const deleted = [];
  const client = {
    async createDatabase(name) { return { name, uuid: TEMPORARY_DATABASE_UUID }; },
    async query(_databaseId, body) {
      if (body.sql.startsWith('SELECT value')) {
        return [{ success: true, results: [{ value: 1 }], meta: {} }];
      }
      return [{ success: true, results: [], meta: {} }];
    },
    async queryAllowingFailure() {
      return structuredClone(EXPECTED_CONSTRAINT_FAILURE);
    },
    async deleteDatabase(databaseId) { deleted.push(databaseId); },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async () => {},
      log: () => assert.fail('must not log success'),
    }),
    /rollback되지 않았습니다/,
  );
  assert.deepEqual(deleted, [TEMPORARY_DATABASE_UUID]);
});

const INVALID_ROLLBACK_PROOFS = [
  {
    name: 'null value',
    verification: [{ success: true, results: [{ value: null }], meta: {} }],
  },
  {
    name: 'empty string value',
    verification: [{ success: true, results: [{ value: '' }], meta: {} }],
  },
  {
    name: 'false value',
    verification: [{ success: true, results: [{ value: false }], meta: {} }],
  },
  {
    name: 'missing row',
    verification: [{ success: true, results: [], meta: {} }],
  },
  {
    name: 'multiple rows',
    verification: [{
      success: true,
      results: [{ value: 0 }, { value: 0 }],
      meta: {},
    }],
  },
  {
    name: 'missing verification result',
    verification: [],
  },
  {
    name: 'multiple verification results',
    verification: [
      { success: true, results: [{ value: 0 }], meta: {} },
      { success: true, results: [{ value: 0 }], meta: {} },
    ],
  },
];

for (const { name, verification } of INVALID_ROLLBACK_PROOFS) {
  test(`rollback proof는 ${name} 응답을 거부하고 disposable D1을 삭제한다`, async () => {
    const deleted = [];
    const logs = [];
    const client = {
      async createDatabase(databaseName) {
        return { name: databaseName, uuid: TEMPORARY_DATABASE_UUID };
      },
      async query(_databaseId, body) {
        if (body.sql.startsWith('SELECT value')) return verification;
        return [{ success: true, results: [], meta: {} }];
      },
      async queryAllowingFailure() {
        return structuredClone(EXPECTED_CONSTRAINT_FAILURE);
      },
      async deleteDatabase(databaseId) { deleted.push(databaseId); },
    };

    await assert.rejects(
      runD1RestBatchContract({
        client,
        runId: '123',
        runAttempt: '1',
        sleep: async () => {},
        log: (message) => logs.push(message),
      }),
      /rollback되지 않았습니다/,
    );
    assert.deepEqual(logs, []);
    assert.deepEqual(deleted, [TEMPORARY_DATABASE_UUID]);
  });
}

test('readiness retry가 모두 실패해도 생성한 disposable D1을 삭제한다', async () => {
  const deleted = [];
  let attempts = 0;
  let sleeps = 0;
  const client = {
    async createDatabase(name) { return { name, uuid: TEMPORARY_DATABASE_UUID }; },
    async query() {
      attempts += 1;
      throw new Error('database not ready');
    },
    async queryAllowingFailure() { assert.fail('must not submit failure batch'); },
    async deleteDatabase(databaseId) { deleted.push(databaseId); },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async (milliseconds) => {
        assert.equal(milliseconds, 500);
        sleeps += 1;
      },
    }),
    /database not ready/,
  );
  assert.equal(attempts, 10);
  assert.equal(sleeps, 9);
  assert.deepEqual(deleted, [TEMPORARY_DATABASE_UUID]);
});

test('missing/empty/malformed UUID create success는 exact-name lookup으로 정리하고 setup하지 않는다', async (t) => {
  const scenarios = [
    { name: 'missing uuid', createResult: (databaseName) => ({ name: databaseName }) },
    { name: 'empty uuid', createResult: (databaseName) => ({ name: databaseName, uuid: '' }) },
    { name: 'whitespace uuid', createResult: (databaseName) => ({ name: databaseName, uuid: '   ' }) },
    { name: 'non-string uuid', createResult: (databaseName) => ({ name: databaseName, uuid: 42 }) },
    { name: 'path-separator uuid', createResult: (databaseName) => ({ name: databaseName, uuid: '../other-endpoint' }) },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const listedNames = [];
      const deleted = [];
      const logs = [];
      let setupCalls = 0;
      let listCompleted = false;
      let deleteCompleted = false;
      let listCalls = 0;
      const client = {
        async createDatabase(databaseName) {
          return scenario.createResult(databaseName);
        },
        async listDatabasesByExactName(databaseName) {
          listedNames.push(databaseName);
          listCalls += 1;
          if (listCalls === 1) return [];
          await Promise.resolve();
          listCompleted = true;
          return [{ name: databaseName, uuid: LOOKUP_CLEANUP_UUID }];
        },
        async query() {
          setupCalls += 1;
          throw new Error('setup must not run');
        },
        async queryAllowingFailure() {
          throw new Error('failure batch must not run');
        },
        async deleteDatabase(databaseId) {
          await Promise.resolve();
          deleted.push(databaseId);
          deleteCompleted = true;
        },
      };

      await assert.rejects(
        runD1RestBatchContract({
          client,
          runId: '123',
          runAttempt: '1',
          sleep: async () => {},
          log: (message) => logs.push(message),
        }),
        /create response was invalid/,
      );

      assert.equal(setupCalls, 0);
      assert.equal(listCompleted, true);
      assert.equal(deleteCompleted, true);
      assert.deepEqual(listedNames, [SHORT_DATABASE_NAME, SHORT_DATABASE_NAME]);
      assert.deepEqual(deleted, [LOOKUP_CLEANUP_UUID]);
      assert.deepEqual(logs, []);
    });
  }
});

test('mismatched create name의 usable UUID는 lookup 없이 보존해 정리한다', async () => {
  const deleted = [];
  const logs = [];
  let listCalls = 0;
  let setupCalls = 0;
  const client = {
    async createDatabase() {
      return { name: 'unexpected-server-name', uuid: DIRECT_CLEANUP_UUID };
    },
    async listDatabasesByExactName() {
      listCalls += 1;
      return [];
    },
    async query() {
      setupCalls += 1;
      return validContractQuery({ sql: 'SELECT value' });
    },
    async queryAllowingFailure() {
      throw new Error('failure batch must not run');
    },
    async deleteDatabase(databaseId) {
      await Promise.resolve();
      deleted.push(databaseId);
    },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async () => {},
      log: (message) => logs.push(message),
    }),
    /create response was invalid/,
  );
  assert.equal(setupCalls, 0);
  assert.equal(listCalls, 1);
  assert.deepEqual(deleted, [DIRECT_CLEANUP_UUID]);
  assert.deepEqual(logs, []);
});

test('adapter가 malformed create의 cleanup UUID를 담아 거부해도 직접 정리한다', async () => {
  const deleted = [];
  let listCalls = 0;
  const client = {
    async createDatabase() { throw createErrorWithCleanupUuid(DIRECT_CLEANUP_UUID); },
    async listDatabasesByExactName() { listCalls += 1; return []; },
    async query() { throw new Error('setup must not run'); },
    async queryAllowingFailure() { throw new Error('failure batch must not run'); },
    async deleteDatabase(databaseId) {
      await Promise.resolve();
      deleted.push(databaseId);
    },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async () => {},
      log: () => assert.fail('must not log success'),
    }),
    /create response was invalid/,
  );
  assert.equal(listCalls, 1);
  assert.deepEqual(deleted, [DIRECT_CLEANUP_UUID]);
});

test('ambiguous create transport는 deterministic exact name lookup과 delete를 모두 기다린다', async () => {
  const listedNames = [];
  const deleted = [];
  const logs = [];
  let listCompleted = false;
  let deleteCompleted = false;
  let listCalls = 0;
  const client = {
    async createDatabase() { throw createAmbiguousError(); },
    async listDatabasesByExactName(databaseName) {
      listedNames.push(databaseName);
      listCalls += 1;
      if (listCalls === 1) return [];
      await Promise.resolve();
      listCompleted = true;
      return [{ name: databaseName, uuid: LOOKUP_CLEANUP_UUID }];
    },
    async query() { throw new Error('setup must not run'); },
    async queryAllowingFailure() { throw new Error('failure batch must not run'); },
    async deleteDatabase(databaseId) {
      await Promise.resolve();
      deleted.push(databaseId);
      deleteCompleted = true;
    },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async () => {},
      log: (message) => logs.push(message),
    }),
    /Cloudflare D1 request failed/,
  );
  assert.equal(listCompleted, true);
  assert.equal(deleteCompleted, true);
  assert.deepEqual(listedNames, [SHORT_DATABASE_NAME, SHORT_DATABASE_NAME]);
  assert.deepEqual(deleted, [LOOKUP_CLEANUP_UUID]);
  assert.deepEqual(logs, []);
});

test('ambiguous create lookup 결과가 0건이면 unrelated database를 삭제하지 않는다', async () => {
  const deleted = [];
  const listedNames = [];
  let sleeps = 0;
  const client = {
    async createDatabase() { throw createAmbiguousError(); },
    async listDatabasesByExactName(databaseName) {
      listedNames.push(databaseName);
      return [];
    },
    async query() { throw new Error('setup must not run'); },
    async queryAllowingFailure() { throw new Error('failure batch must not run'); },
    async deleteDatabase(databaseId) { deleted.push(databaseId); },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async (milliseconds) => {
        assert.equal(milliseconds, 500);
        sleeps += 1;
      },
      log: () => assert.fail('must not log success'),
    }),
    /Cloudflare D1 request failed/,
  );
  assert.equal(listedNames.length, 11);
  assert.equal(listedNames.every((name) => name === SHORT_DATABASE_NAME), true);
  assert.equal(sleeps, 9);
  assert.deepEqual(deleted, []);
});

test('ambiguous/malformed exact-name lookup은 fail closed 하며 아무 UUID도 삭제하지 않는다', async (t) => {
  const scenarios = [
    {
      name: 'multiple exact matches',
      matches: [
        { name: SHORT_DATABASE_NAME, uuid: DIRECT_CLEANUP_UUID },
        { name: SHORT_DATABASE_NAME, uuid: LOOKUP_CLEANUP_UUID },
      ],
    },
    { name: 'malformed exact match', matches: [{ name: SHORT_DATABASE_NAME, uuid: '' }] },
    { name: 'non-exact match', matches: [{ name: 'unrelated', uuid: DIRECT_CLEANUP_UUID }] },
    { name: 'malformed result', matches: null },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const deleted = [];
      const logs = [];
      let listCalls = 0;
      const client = {
        async createDatabase() { throw createAmbiguousError(); },
        async listDatabasesByExactName() {
          listCalls += 1;
          return listCalls === 1 ? [] : scenario.matches;
        },
        async query() { throw new Error('setup must not run'); },
        async queryAllowingFailure() { throw new Error('failure batch must not run'); },
        async deleteDatabase(databaseId) { deleted.push(databaseId); },
      };

      await assert.rejects(
        runD1RestBatchContract({
          client,
          runId: '123',
          runAttempt: '1',
          sleep: async () => {},
          log: (message) => logs.push(message),
        }),
        (error) => {
          assert.equal(error.message, 'Disposable D1 cleanup failed.');
          assert.ok(!error.message.includes(DIRECT_CLEANUP_UUID));
          assert.ok(!error.message.includes(LOOKUP_CLEANUP_UUID));
          return true;
        },
      );
      assert.deepEqual(deleted, []);
      assert.deepEqual(logs, []);
    });
  }
});

test('definite create rejection은 기존 exact-name database를 lookup하거나 삭제하지 않는다', async () => {
  const logs = [];
  let listCalls = 0;
  let deleteCalls = 0;
  const client = {
    async createDatabase() {
      throw new Error('Cloudflare D1 request failed with HTTP 409.');
    },
    async listDatabasesByExactName() {
      listCalls += 1;
      return listCalls === 1
        ? []
        : [{ name: SHORT_DATABASE_NAME, uuid: DIRECT_CLEANUP_UUID }];
    },
    async query() { throw new Error('setup must not run'); },
    async queryAllowingFailure() { throw new Error('failure batch must not run'); },
    async deleteDatabase() { deleteCalls += 1; },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async () => {},
      log: (message) => logs.push(message),
    }),
    /HTTP 409/,
  );
  assert.equal(listCalls, 1);
  assert.equal(deleteCalls, 0);
  assert.deepEqual(logs, []);
});

test('각 invocation은 주입 가능한 lowercase hex suffix로 서로 다른 32자 이하 name을 만든다', async () => {
  const createdNames = [];
  const suffixes = ['000000000000', 'ffffffffffff'];

  for (const suffix of suffixes) {
    await assert.rejects(
      runD1RestBatchContract({
        client: {
          async listDatabasesByExactName() { return []; },
          async createDatabase(databaseName) {
            createdNames.push(databaseName);
            throw new Error('definite create rejection');
          },
          async query() { throw new Error('setup must not run'); },
          async queryAllowingFailure() { throw new Error('failure batch must not run'); },
          async deleteDatabase() { throw new Error('delete must not run'); },
        },
        runId: '9876543210',
        runAttempt: '2',
        randomSuffix: () => suffix,
        sleep: async () => {},
        log: () => assert.fail('must not log success'),
      }),
      /definite create rejection/,
    );
  }

  assert.deepEqual(createdNames, [
    'hio-rb-9876543210-2-000000000000',
    'hio-rb-9876543210-2-ffffffffffff',
  ]);
  assert.equal(createdNames.every((name) => name.length <= 32), true);
  assert.equal(createdNames.every((name) => /^hio-rb-[0-9-]+-[0-9a-f]{12}$/.test(name)), true);
});

test('invalid suffix와 random generation 실패는 remote call 전에 fail closed 한다', async (t) => {
  const scenarios = [
    { name: 'short suffix', randomSuffix: () => 'abc' },
    { name: 'uppercase suffix', randomSuffix: () => 'ABCDEF012345' },
    { name: 'non-string suffix', randomSuffix: () => 123456789012 },
    {
      name: 'generator failure',
      randomSuffix: () => { throw new Error('sensitive random failure'); },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let remoteCalls = 0;
      const client = {
        async listDatabasesByExactName() { remoteCalls += 1; return []; },
        async createDatabase() { remoteCalls += 1; },
        async query() { remoteCalls += 1; },
        async queryAllowingFailure() { remoteCalls += 1; },
        async deleteDatabase() { remoteCalls += 1; },
      };

      await assert.rejects(
        runD1RestBatchContract({
          client,
          runId: '123',
          runAttempt: '1',
          randomSuffix: scenario.randomSuffix,
          sleep: async () => {},
          log: () => assert.fail('must not log success'),
        }),
        (error) => {
          assert.equal(error.message, 'Disposable D1 invocation suffix generation failed.');
          assert.doesNotMatch(error.message, /sensitive/);
          return true;
        },
      );
      assert.equal(remoteCalls, 0);
    });
  }
});

test('preexisting exact-name database가 있으면 create와 delete 없이 중단한다', async () => {
  let createCalls = 0;
  let deleteCalls = 0;
  let preexistingName;
  const client = {
    async listDatabasesByExactName(databaseName) {
      preexistingName = databaseName;
      return [{ name: databaseName, uuid: DIRECT_CLEANUP_UUID }];
    },
    async createDatabase() { createCalls += 1; },
    async query() { throw new Error('setup must not run'); },
    async queryAllowingFailure() { throw new Error('failure batch must not run'); },
    async deleteDatabase() { deleteCalls += 1; },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async () => {},
      log: () => assert.fail('must not log success'),
    }),
    /name is already in use/,
  );
  assert.equal(preexistingName, SHORT_DATABASE_NAME);
  assert.equal(createCalls, 0);
  assert.equal(deleteCalls, 0);
});

test('ambiguous create 뒤 늦게 나타난 exact match를 bounded retry 후 삭제한다', async () => {
  let listCalls = 0;
  let sleeps = 0;
  const deleted = [];
  const client = {
    async listDatabasesByExactName(databaseName) {
      listCalls += 1;
      if (listCalls <= 3) return [];
      return [{ name: databaseName, uuid: LOOKUP_CLEANUP_UUID }];
    },
    async createDatabase() { throw createAmbiguousError(); },
    async query() { throw new Error('setup must not run'); },
    async queryAllowingFailure() { throw new Error('failure batch must not run'); },
    async deleteDatabase(databaseId) { deleted.push(databaseId); },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async (milliseconds) => {
        assert.equal(milliseconds, 500);
        sleeps += 1;
      },
      log: () => assert.fail('must not log success'),
    }),
    /Cloudflare D1 request failed/,
  );
  assert.equal(listCalls, 4);
  assert.equal(sleeps, 2);
  assert.deepEqual(deleted, [LOOKUP_CLEANUP_UUID]);
});

test('missing-UUID success가 10회 lookup에도 없으면 cleanup failure로 block한다', async () => {
  let listCalls = 0;
  let sleeps = 0;
  let setupCalls = 0;
  const client = {
    async listDatabasesByExactName() { listCalls += 1; return []; },
    async createDatabase(name) { return { name }; },
    async query() { setupCalls += 1; throw new Error('setup must not run'); },
    async queryAllowingFailure() { throw new Error('failure batch must not run'); },
    async deleteDatabase() { throw new Error('delete must not run'); },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async (milliseconds) => {
        assert.equal(milliseconds, 500);
        sleeps += 1;
      },
      log: () => assert.fail('must not log success'),
    }),
    /Disposable D1 cleanup failed/,
  );
  assert.equal(listCalls, 11);
  assert.equal(sleeps, 9);
  assert.equal(setupCalls, 0);
});

test('cleanup exact-name list의 retryable failure 뒤 match를 찾아 삭제한다', async () => {
  let listCalls = 0;
  let sleeps = 0;
  const deleted = [];
  const client = {
    async listDatabasesByExactName(databaseName) {
      listCalls += 1;
      if (listCalls === 1) return [];
      if (listCalls === 2) throw createRetryableError(503);
      return [{ name: databaseName, uuid: LOOKUP_CLEANUP_UUID }];
    },
    async createDatabase() { throw createAmbiguousError(); },
    async query() { throw new Error('setup must not run'); },
    async queryAllowingFailure() { throw new Error('failure batch must not run'); },
    async deleteDatabase(databaseId) { deleted.push(databaseId); },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async (milliseconds) => {
        assert.equal(milliseconds, 500);
        sleeps += 1;
      },
      log: () => assert.fail('must not log success'),
    }),
    /Cloudflare D1 request failed/,
  );
  assert.equal(listCalls, 3);
  assert.equal(sleeps, 1);
  assert.deepEqual(deleted, [LOOKUP_CLEANUP_UUID]);
});

test('cleanup delete의 retryable failure 뒤 성공을 기다린다', async () => {
  let deleteCalls = 0;
  let sleeps = 0;
  const logs = [];
  const client = {
    async createDatabase(name) { return { name, uuid: DIRECT_CLEANUP_UUID }; },
    async query(_databaseId, body) { return validContractQuery(body); },
    async queryAllowingFailure() { return structuredClone(EXPECTED_CONSTRAINT_FAILURE); },
    async deleteDatabase() {
      deleteCalls += 1;
      if (deleteCalls === 1) throw createRetryableError(503);
    },
  };

  await runD1RestBatchContract({
    client,
    runId: '123',
    runAttempt: '1',
    sleep: async (milliseconds) => {
      assert.equal(milliseconds, 500);
      sleeps += 1;
    },
    log: (message) => logs.push(message),
  });

  assert.equal(deleteCalls, 2);
  assert.equal(sleeps, 1);
  assert.deepEqual(logs, [
    `D1 REST batch rollback verified: ${SHORT_DATABASE_NAME}/${DIRECT_CLEANUP_UUID}`,
  ]);
});

test('cleanup list/delete의 retryable failure가 10회면 completion을 block한다', async (t) => {
  await t.test('list exhaustion', async () => {
    let listCalls = 0;
    let sleeps = 0;
    let deleteCalls = 0;
    const client = {
      async listDatabasesByExactName() {
        listCalls += 1;
        if (listCalls === 1) return [];
        throw createRetryableError(503);
      },
      async createDatabase() { throw createAmbiguousError(); },
      async query() { throw new Error('setup must not run'); },
      async queryAllowingFailure() { throw new Error('failure batch must not run'); },
      async deleteDatabase() { deleteCalls += 1; },
    };

    await assert.rejects(
      runD1RestBatchContract({
        client,
        runId: '123',
        runAttempt: '1',
        sleep: async (milliseconds) => {
          assert.equal(milliseconds, 500);
          sleeps += 1;
        },
        log: () => assert.fail('must not log success'),
      }),
      /Disposable D1 cleanup failed/,
    );
    assert.equal(listCalls, 11);
    assert.equal(sleeps, 9);
    assert.equal(deleteCalls, 0);
  });

  await t.test('delete exhaustion', async () => {
    let deleteCalls = 0;
    let sleeps = 0;
    const client = {
      async createDatabase(name) { return { name, uuid: DIRECT_CLEANUP_UUID }; },
      async query(_databaseId, body) { return validContractQuery(body); },
      async queryAllowingFailure() { return structuredClone(EXPECTED_CONSTRAINT_FAILURE); },
      async deleteDatabase() {
        deleteCalls += 1;
        throw createRetryableError(503);
      },
    };

    await assert.rejects(
      runD1RestBatchContract({
        client,
        runId: '123',
        runAttempt: '1',
        sleep: async (milliseconds) => {
          assert.equal(milliseconds, 500);
          sleeps += 1;
        },
        log: () => assert.fail('must not log success'),
      }),
      /Disposable D1 cleanup failed/,
    );
    assert.equal(deleteCalls, 10);
    assert.equal(sleeps, 9);
  });
});

test('cleanup list/delete의 nonretryable failure는 반복하지 않는다', async (t) => {
  await t.test('list rejection', async () => {
    let listCalls = 0;
    let sleeps = 0;
    const client = {
      async listDatabasesByExactName() {
        listCalls += 1;
        if (listCalls === 1) return [];
        throw createNonRetryableError(403);
      },
      async createDatabase() { throw createAmbiguousError(); },
      async query() { throw new Error('setup must not run'); },
      async queryAllowingFailure() { throw new Error('failure batch must not run'); },
      async deleteDatabase() { throw new Error('delete must not run'); },
    };

    await assert.rejects(
      runD1RestBatchContract({
        client,
        runId: '123',
        runAttempt: '1',
        sleep: async () => { sleeps += 1; },
        log: () => assert.fail('must not log success'),
      }),
      /Disposable D1 cleanup failed/,
    );
    assert.equal(listCalls, 2);
    assert.equal(sleeps, 0);
  });

  await t.test('delete rejection', async () => {
    let deleteCalls = 0;
    let sleeps = 0;
    const client = {
      async createDatabase(name) { return { name, uuid: DIRECT_CLEANUP_UUID }; },
      async query(_databaseId, body) { return validContractQuery(body); },
      async queryAllowingFailure() { return structuredClone(EXPECTED_CONSTRAINT_FAILURE); },
      async deleteDatabase() {
        deleteCalls += 1;
        throw createNonRetryableError(403);
      },
    };

    await assert.rejects(
      runD1RestBatchContract({
        client,
        runId: '123',
        runAttempt: '1',
        sleep: async () => { sleeps += 1; },
        log: () => assert.fail('must not log success'),
      }),
      /Disposable D1 cleanup failed/,
    );
    assert.equal(deleteCalls, 1);
    assert.equal(sleeps, 0);
  });
});

test('delete 응답 유실 뒤 404는 exact-name 부재를 확인해야만 cleanup 성공이다', async () => {
  let listCalls = 0;
  let deleteCalls = 0;
  let sleeps = 0;
  const logs = [];
  const client = {
    async listDatabasesByExactName() {
      listCalls += 1;
      return [];
    },
    async createDatabase(name) { return { name, uuid: DIRECT_CLEANUP_UUID }; },
    async query(_databaseId, body) { return validContractQuery(body); },
    async queryAllowingFailure() { return structuredClone(EXPECTED_CONSTRAINT_FAILURE); },
    async deleteDatabase() {
      deleteCalls += 1;
      if (deleteCalls === 1) throw createRetryableError();
      throw createNonRetryableError(404);
    },
  };

  await runD1RestBatchContract({
    client,
    runId: '123',
    runAttempt: '1',
    sleep: async (milliseconds) => {
      assert.equal(milliseconds, 500);
      sleeps += 1;
    },
    log: (message) => logs.push(message),
  });

  assert.equal(listCalls, 2);
  assert.equal(deleteCalls, 2);
  assert.equal(sleeps, 1);
  assert.deepEqual(logs, [
    `D1 REST batch rollback verified: ${SHORT_DATABASE_NAME}/${DIRECT_CLEANUP_UUID}`,
  ]);
});

test('delete 응답 유실 뒤 404와 same UUID match면 남은 budget으로 delete를 계속한다', async () => {
  let listCalls = 0;
  let deleteCalls = 0;
  let sleeps = 0;
  const logs = [];
  const client = {
    async listDatabasesByExactName(databaseName) {
      listCalls += 1;
      if (listCalls === 1) return [];
      return [{ name: databaseName, uuid: DIRECT_CLEANUP_UUID }];
    },
    async createDatabase(name) { return { name, uuid: DIRECT_CLEANUP_UUID }; },
    async query(_databaseId, body) { return validContractQuery(body); },
    async queryAllowingFailure() { return structuredClone(EXPECTED_CONSTRAINT_FAILURE); },
    async deleteDatabase() {
      deleteCalls += 1;
      if (deleteCalls === 1) throw createRetryableError();
      if (deleteCalls === 2) throw createNonRetryableError(404);
    },
  };

  await runD1RestBatchContract({
    client,
    runId: '123',
    runAttempt: '1',
    sleep: async (milliseconds) => {
      assert.equal(milliseconds, 500);
      sleeps += 1;
    },
    log: (message) => logs.push(message),
  });
  assert.equal(listCalls, 2);
  assert.equal(deleteCalls, 3);
  assert.equal(sleeps, 2);
  assert.deepEqual(logs, [
    `D1 REST batch rollback verified: ${SHORT_DATABASE_NAME}/${DIRECT_CLEANUP_UUID}`,
  ]);
});

test('rollback success는 disposable delete가 끝난 뒤에만 completion을 기록한다', async () => {
  let releaseDelete;
  let notifyDeleteStarted;
  const deleteStarted = new Promise((resolve) => { notifyDeleteStarted = resolve; });
  const deleteRelease = new Promise((resolve) => { releaseDelete = resolve; });
  const logs = [];
  let settled = false;
  const client = {
    async createDatabase(name) { return { name, uuid: DIRECT_CLEANUP_UUID }; },
    async query(_databaseId, body) { return validContractQuery(body); },
    async queryAllowingFailure() { return structuredClone(EXPECTED_CONSTRAINT_FAILURE); },
    async deleteDatabase() {
      notifyDeleteStarted();
      await deleteRelease;
    },
  };

  const run = runD1RestBatchContract({
    client,
    runId: '123',
    runAttempt: '1',
    sleep: async () => {},
    log: (message) => logs.push(message),
  }).finally(() => { settled = true; });

  await deleteStarted;
  const logsBeforeDelete = [...logs];
  const settledBeforeDelete = settled;
  releaseDelete();
  await run;

  assert.deepEqual(logsBeforeDelete, []);
  assert.equal(settledBeforeDelete, false);
  assert.deepEqual(logs, [
    `D1 REST batch rollback verified: ${SHORT_DATABASE_NAME}/${DIRECT_CLEANUP_UUID}`,
  ]);
});

test('verified rollback의 delete 실패는 completion을 막고 sanitized cleanup 오류로 거부한다', async () => {
  const logs = [];
  const client = {
    async createDatabase(name) { return { name, uuid: DIRECT_CLEANUP_UUID }; },
    async query(_databaseId, body) { return validContractQuery(body); },
    async queryAllowingFailure() { return structuredClone(EXPECTED_CONSTRAINT_FAILURE); },
    async deleteDatabase() {
      await Promise.resolve();
      throw new Error(`server detail ${DIRECT_CLEANUP_UUID}`);
    },
  };

  await assert.rejects(
    runD1RestBatchContract({
      client,
      runId: '123',
      runAttempt: '1',
      sleep: async () => {},
      log: (message) => logs.push(message),
    }),
    (error) => {
      assert.equal(error.message, 'Disposable D1 cleanup failed.');
      assert.ok(!error.message.includes(DIRECT_CLEANUP_UUID));
      assert.doesNotMatch(error.message, /server detail/);
      return true;
    },
  );
  assert.deepEqual(logs, []);
});
