import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { runD1RestBatchContract } from './d1-rest-batch-contract.mjs';

const EXPECTED_FAILURE_BATCH = {
  batch: [
    { sql: 'UPDATE contract_state SET value = 1 WHERE id = ?', params: ['1'] },
    { sql: 'INSERT INTO contract_guard(value) VALUES (?)', params: ['0'] },
  ],
};

const workflow = readFileSync(
  new URL('../.github/workflows/deploy-worker.yml', import.meta.url),
  'utf8',
);
const packageJson = JSON.parse(readFileSync(
  new URL('../package.json', import.meta.url),
  'utf8',
));

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
      return { name, uuid: 'temporary-db-id' };
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
      return {
        httpOk: true,
        envelope: { success: true, result: [{ success: false, results: [], meta: {} }] },
      };
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
  assert.equal(createdName, 'hio-rb-1234567890123456789012345');
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
      sql: 'CREATE TABLE contract_guard(value INTEGER CHECK(value > 0))',
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
  assert.deepEqual(deleted, ['temporary-db-id']);
  assert.deepEqual(logs, [
    `D1 REST batch rollback verified: ${createdName}/temporary-db-id`,
  ]);
});

test('failure batch가 모두 성공으로 보고되면 contract를 실패시키고 삭제한다', async () => {
  const deleted = [];
  let verificationQueries = 0;
  const client = {
    async createDatabase() { return { name: 'temporary', uuid: 'temporary-db-id' }; },
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
    /성공으로 보고/,
  );
  assert.equal(verificationQueries, 0);
  assert.deepEqual(deleted, ['temporary-db-id']);
});

test('malformed statement result도 failure로 취급하고 rollback을 검증한다', async () => {
  const deleted = [];
  const client = {
    async createDatabase() { return { name: 'temporary', uuid: 'temporary-db-id' }; },
    async query(_databaseId, body) {
      if (body.sql.startsWith('SELECT value')) {
        return [{ success: true, results: [{ value: 0 }], meta: {} }];
      }
      return [{ success: true, results: [], meta: {} }];
    },
    async queryAllowingFailure() {
      return { httpOk: true, envelope: { success: true, result: [null] } };
    },
    async deleteDatabase(databaseId) { deleted.push(databaseId); },
  };

  await runD1RestBatchContract({
    client,
    runId: '123',
    runAttempt: '1',
    sleep: async () => {},
    log() {},
  });
  assert.deepEqual(deleted, ['temporary-db-id']);
});

test('rollback assertion이 실패해도 disposable D1을 삭제한다', async () => {
  const deleted = [];
  const client = {
    async createDatabase() { return { name: 'temporary', uuid: 'temporary-db-id' }; },
    async query(_databaseId, body) {
      if (body.sql.startsWith('SELECT value')) {
        return [{ success: true, results: [{ value: 1 }], meta: {} }];
      }
      return [{ success: true, results: [], meta: {} }];
    },
    async queryAllowingFailure() {
      return { httpOk: false, envelope: { success: false, result: [] } };
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
  assert.deepEqual(deleted, ['temporary-db-id']);
});

test('readiness retry가 모두 실패해도 생성한 disposable D1을 삭제한다', async () => {
  const deleted = [];
  let attempts = 0;
  let sleeps = 0;
  const client = {
    async createDatabase() { return { name: 'temporary', uuid: 'temporary-db-id' }; },
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
  assert.deepEqual(deleted, ['temporary-db-id']);
});
