import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSmokeIdentityRemoteTarget,
  buildSmokeIdentityOperationReport,
  parseSmokeIdentityEnvironment,
  renderSmokeIdentityOperationSummary,
  runManageSmokeIdentity,
} from './manage-smoke-identity.mjs';

const PASSWORD = 'x'.repeat(64);
const DATABASE_ID = '6de5b982-fd82-4e0a-a56d-9e7bde948839';
const OPERATION_ID = 'a1111111-b111-4111-8111-c11111111111';
const PASSWORD_HASH = `pbkdf2_sha256$100000$${'a'.repeat(32)}$${'b'.repeat(64)}`;
const BASE_ENV = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '1',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'cloudflare-token-sensitive',
  PRODUCTION_SMOKE_PASSWORD: PASSWORD,
  SMOKE_IDENTITY_CONFIRMATION: 'MANAGE hereisorder deployment-smoke provision',
  GITHUB_STEP_SUMMARY: '/tmp/smoke-summary.md',
};

const validDependencies = {
  argv: ['provision', '--remote'],
  env: BASE_ENV,
  now: () => new Date('2026-07-13T18:00:00.000Z'),
  readBinding: () => ({
    binding: 'DB',
    databaseName: 'hereisorder',
    databaseId: DATABASE_ID,
  }),
  createHash: () => PASSWORD_HASH,
  createClient: () => ({
    async listDatabasesByExactName() {
      return [{ name: 'hereisorder', uuid: DATABASE_ID }];
    },
    async query() {
      return [{ success: true, results: [], meta: { changes: 0 } }];
    },
  }),
  runLifecycle: async () => ({ id: 41, active: true }),
  appendSummary: async () => {},
  log: async () => {},
};

test('environment is exact main workflow_dispatch and disable rejects password exposure', () => {
  const parsed = parseSmokeIdentityEnvironment({ env: BASE_ENV, action: 'provision' });
  assert.equal(parsed.password, PASSWORD);
  assert.equal(parsed.accountId, 'a'.repeat(32));

  for (const patch of [
    { CI: 'false' }, { GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_RUN_ID: '0' },
    { GITHUB_RUN_ATTEMPT: '0' }, { CLOUDFLARE_ACCOUNT_ID: 'not-an-account' },
    { CLOUDFLARE_API_TOKEN: ' token ' }, { PRODUCTION_SMOKE_PASSWORD: undefined },
    { SMOKE_IDENTITY_CONFIRMATION: 'wrong' }, { GITHUB_STEP_SUMMARY: 'relative.md' },
  ]) {
    assert.throws(
      () => parseSmokeIdentityEnvironment({
        env: { ...BASE_ENV, ...patch },
        action: 'provision',
      }),
      (error) => error.message === 'Smoke identity environment was invalid.'
        && !error.message.includes(PASSWORD)
        && !error.message.includes('cloudflare-token-sensitive'),
    );
  }
  assert.throws(() => parseSmokeIdentityEnvironment({
    env: {
      ...BASE_ENV,
      SMOKE_IDENTITY_CONFIRMATION: 'MANAGE hereisorder deployment-smoke disable',
    },
    action: 'disable',
  }));
  const { PRODUCTION_SMOKE_PASSWORD: _removed, ...withoutPassword } = BASE_ENV;
  assert.doesNotThrow(() => parseSmokeIdentityEnvironment({
    env: {
      ...withoutPassword,
      SMOKE_IDENTITY_CONFIRMATION: 'MANAGE hereisorder deployment-smoke disable',
    },
    action: 'disable',
  }));
});

test('validation precedes config, hashing, client and fetch', async () => {
  for (const invalidInput of [
    { argv: ['provision'], env: BASE_ENV },
    { argv: ['provision', '--remote'], env: { ...BASE_ENV, CI: 'false' } },
  ]) {
    const calls = [];
    await assert.rejects(runManageSmokeIdentity({
      ...invalidInput,
      readBinding: () => {
        calls.push('binding');
        return { binding: 'DB', databaseName: 'hereisorder', databaseId: DATABASE_ID };
      },
      createHash: () => {
        calls.push('hash');
        return PASSWORD_HASH;
      },
      createClient: () => {
        calls.push('client');
        return {
          async listDatabasesByExactName() {
            calls.push('fetch');
            return [{ name: 'hereisorder', uuid: DATABASE_ID }];
          },
          async query() {
            return [{ success: true, results: [], meta: { changes: 0 } }];
          },
        };
      },
      runLifecycle: async () => {
        calls.push('lifecycle');
        return { id: 41, active: true };
      },
    }), (error) => error.message === 'Smoke identity operation failed.');
    assert.deepEqual(calls, []);
  }
});

test('remote D1 exact-name lookup must match the configured UUID', () => {
  const binding = {
    binding: 'DB',
    databaseName: 'hereisorder',
    databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839',
  };
  assert.deepEqual(assertSmokeIdentityRemoteTarget([
    { name: 'hereisorder', uuid: binding.databaseId },
  ], binding), {
    databaseName: 'hereisorder',
    databaseId: binding.databaseId,
  });
  for (const matches of [
    [],
    [null],
    [{ name: 'hereisorder', uuid: '11111111-1111-4111-8111-111111111111' }],
    [{ name: 'other', uuid: binding.databaseId }],
    [
      { name: 'hereisorder', uuid: binding.databaseId },
      { name: 'hereisorder', uuid: binding.databaseId },
    ],
  ]) {
    assert.throws(() => assertSmokeIdentityRemoteTarget(matches, binding));
  }
});

test('adapter accepts only exact binding, writes summary before safe log, and redacts secrets', async () => {
  const events = [];
  const lifecycleCalls = [];
  const client = {
    async listDatabasesByExactName() {
      return [{ name: 'hereisorder', uuid: DATABASE_ID }];
    },
    async query() {
      return [{ success: true, results: [], meta: { changes: 0 } }];
    },
  };
  const report = await runManageSmokeIdentity({
    argv: ['provision', '--remote'],
    env: BASE_ENV,
    now: () => new Date('2026-07-13T18:00:00.000Z'),
    readBinding: () => ({
      binding: 'DB',
      databaseName: 'hereisorder',
      databaseId: DATABASE_ID,
    }),
    createHash: (password) => {
      assert.equal(password, PASSWORD);
      return PASSWORD_HASH;
    },
    createClient: (input) => {
      assert.deepEqual(input, {
        accountId: 'a'.repeat(32),
        apiToken: 'cloudflare-token-sensitive',
      });
      return client;
    },
    runLifecycle: async (input) => {
      lifecycleCalls.push(input);
      return { id: 41, active: true };
    },
    appendSummary: async (_path, contents) => events.push(['summary', contents]),
    log: async (contents) => events.push(['log', contents]),
  });
  assert.deepEqual(report, {
    operationVersion: 'production-smoke-identity-operation-v1',
    executedAt: '2026-07-13T18:00:00.000Z',
    databaseName: 'hereisorder',
    action: 'provision',
    outcome: 'completed',
  });
  assert.equal(Object.isFrozen(report), true);
  assert.deepEqual(events.map(([kind]) => kind), ['summary', 'log']);
  assert.equal(events[0][1], renderSmokeIdentityOperationSummary(report));
  assert.equal(events[1][1], JSON.stringify(report));
  assert.deepEqual(Object.keys(lifecycleCalls[0]), [
    'client', 'databaseId', 'action', 'passwordHash',
  ]);
  assert.equal(lifecycleCalls[0].client, client);
  assert.equal(lifecycleCalls[0].databaseId, DATABASE_ID);
  assert.equal(lifecycleCalls[0].action, 'provision');
  assert.equal(lifecycleCalls[0].passwordHash, PASSWORD_HASH);
  assert.equal(Object.hasOwn(lifecycleCalls[0], 'operationId'), false);
  const serialized = JSON.stringify({ report, events });
  for (const sensitive of [
    PASSWORD,
    'cloudflare-token-sensitive',
    'a'.repeat(32),
    DATABASE_ID,
    'deployment-smoke',
  ]) {
    assert.equal(serialized.includes(sensitive), false);
  }
  assert.equal(serialized.includes('"id":41'), false);
  assert.equal(serialized.includes('"active":true'), false);
});

test('rotate and disable preserve exact lifecycle wiring and disable never hashes', async () => {
  const { PRODUCTION_SMOKE_PASSWORD: _removed, ...withoutPassword } = BASE_ENV;
  for (const action of ['rotate', 'disable']) {
    const hashInputs = [];
    const lifecycleCalls = [];
    const client = validDependencies.createClient();
    const env = action === 'disable'
      ? {
          ...withoutPassword,
          SMOKE_IDENTITY_CONFIRMATION: 'MANAGE hereisorder deployment-smoke disable',
        }
      : {
          ...BASE_ENV,
          SMOKE_IDENTITY_CONFIRMATION: 'MANAGE hereisorder deployment-smoke rotate',
        };
    const report = await runManageSmokeIdentity({
      ...validDependencies,
      argv: [action, '--remote'],
      env,
      createHash: (password) => {
        hashInputs.push(password);
        return PASSWORD_HASH;
      },
      createClient: () => client,
      runLifecycle: async (input) => {
        lifecycleCalls.push(input);
        return { id: 41, active: action !== 'disable' };
      },
    });

    assert.deepEqual(hashInputs, action === 'disable' ? [] : [PASSWORD]);
    assert.equal(lifecycleCalls.length, 1);
    assert.deepEqual(Object.keys(lifecycleCalls[0]), [
      'client', 'databaseId', 'action', 'passwordHash',
    ]);
    assert.equal(lifecycleCalls[0].client, client);
    assert.equal(lifecycleCalls[0].databaseId, DATABASE_ID);
    assert.equal(lifecycleCalls[0].action, action);
    assert.equal(
      lifecycleCalls[0].passwordHash,
      action === 'disable' ? undefined : PASSWORD_HASH,
    );
    assert.equal(Object.hasOwn(lifecycleCalls[0], 'operationId'), false);
    assert.equal(report.action, action);
    assert.equal(Object.hasOwn(report, 'id'), false);
    assert.equal(Object.hasOwn(report, 'active'), false);
  }
});

test('report and summary contain only exact safe evidence', () => {
  const report = buildSmokeIdentityOperationReport({
    executedAt: '2026-07-13T18:00:00.000Z',
    action: 'rotate',
    operationId: OPERATION_ID,
    lifecycleResult: { id: 41, active: true },
  });
  assert.deepEqual(report, {
    operationVersion: 'production-smoke-identity-operation-v1',
    executedAt: '2026-07-13T18:00:00.000Z',
    databaseName: 'hereisorder',
    action: 'rotate',
    outcome: 'completed',
  });
  assert.equal(Object.isFrozen(report), true);
  assert.equal(
    renderSmokeIdentityOperationSummary(report),
    `## Production smoke identity operation\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
  );
  assert.throws(
    () => renderSmokeIdentityOperationSummary({ ...report, operationId: OPERATION_ID }),
    (error) => error.message === 'Smoke identity report was invalid.'
      && !error.message.includes(OPERATION_ID),
  );
});

const INVALID_EXECUTED_AT_CASES = [
  ['invalid string', 'private-invalid-report-date'],
  ['non-string', undefined],
  ['impossible ISO date', '2026-02-30T00:00:00.000Z'],
];

test('report builder rejects invalid dates with the exact generic error', async (t) => {
  for (const [name, executedAt] of INVALID_EXECUTED_AT_CASES) {
    await t.test(name, () => {
      assert.throws(
        () => buildSmokeIdentityOperationReport({ executedAt, action: 'provision' }),
        (error) => error.message === 'Smoke identity report was invalid.'
          && !error.message.includes(String(executedAt)),
      );
    });
  }
});

test('summary renderer rejects invalid dates with the exact generic error', async (t) => {
  for (const [name, executedAt] of INVALID_EXECUTED_AT_CASES) {
    await t.test(name, () => {
      assert.throws(
        () => renderSmokeIdentityOperationSummary({
          operationVersion: 'production-smoke-identity-operation-v1',
          executedAt,
          databaseName: 'hereisorder',
          action: 'provision',
          outcome: 'completed',
        }),
        (error) => error.message === 'Smoke identity report was invalid.'
          && !error.message.includes(String(executedAt)),
      );
    });
  }
});

test('binding and remote validation stop hashing and lifecycle', async () => {
  const cases = [
    {
      expectedCalls: ['binding'],
      readBinding: (calls) => {
        calls.push('binding');
        return { binding: 'DB', databaseName: 'other', databaseId: DATABASE_ID };
      },
      remoteUuid: DATABASE_ID,
    },
    {
      expectedCalls: ['binding', 'client', 'fetch'],
      readBinding: (calls) => {
        calls.push('binding');
        return { binding: 'DB', databaseName: 'hereisorder', databaseId: DATABASE_ID };
      },
      remoteUuid: '11111111-1111-4111-8111-111111111111',
    },
  ];
  for (const scenario of cases) {
    const calls = [];
    await assert.rejects(runManageSmokeIdentity({
      ...validDependencies,
      readBinding: () => scenario.readBinding(calls),
      createClient: () => {
        calls.push('client');
        return {
          async listDatabasesByExactName() {
            calls.push('fetch');
            return [{ name: 'hereisorder', uuid: scenario.remoteUuid }];
          },
          async query() {
            return [{ success: true, results: [], meta: { changes: 0 } }];
          },
        };
      },
      createHash: () => {
        calls.push('hash');
        return PASSWORD_HASH;
      },
      runLifecycle: async () => {
        calls.push('lifecycle');
        return { id: 41, active: true };
      },
    }), (error) => error.message === 'Smoke identity operation failed.');
    assert.deepEqual(calls, scenario.expectedCalls);
  }
});

test('binding, remote target, hash and lifecycle failures are generic', async (t) => {
  const cases = [
    ['wrong binding', {
      readBinding: () => ({
        binding: 'DB',
        databaseName: 'other',
        databaseId: DATABASE_ID,
      }),
    }],
    ['wrong remote UUID', {
      createClient: () => ({
        async listDatabasesByExactName() {
          return [{
            name: 'hereisorder',
            uuid: '11111111-1111-4111-8111-111111111111',
          }];
        },
        async query() {
          return [{ success: true, results: [], meta: { changes: 0 } }];
        },
      }),
    }],
    ['hash failure', {
      createHash: () => {
        throw new Error(`hash ${PASSWORD}`);
      },
    }],
    ['lifecycle failure', {
      runLifecycle: async () => {
        throw new Error(`raw production user row deployment-smoke ${OPERATION_ID}`);
      },
    }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        runManageSmokeIdentity({ ...validDependencies, ...override }),
        (error) => error.message === 'Smoke identity operation failed.'
          && !error.message.includes(PASSWORD)
          && !error.message.includes('production user row')
          && !error.message.includes('deployment-smoke')
          && !error.message.includes(OPERATION_ID),
      );
    });
  }
});

test('summary failure leaves no success log', async () => {
  const logs = [];
  await assert.rejects(runManageSmokeIdentity({
    ...validDependencies,
    appendSummary: async () => {
      throw new Error(`summary ${PASSWORD}`);
    },
    log: async (value) => logs.push(value),
  }), (error) => error.message === 'Smoke identity operation failed.');
  assert.deepEqual(logs, []);
});
