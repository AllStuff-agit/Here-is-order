import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  DEPLOYMENT_VERIFICATION_VERSION,
  buildWorkerDeploymentReport,
  getWorkerTarget,
  parseDeploymentVerificationEnvironment,
  parseVerifiedActiveDeployment,
  parseVerifiedWorkerVersion,
  parseWranglerDeployEvidence,
  readVerifiedWorkerDeployment,
  renderWorkerDeploymentSummary,
  runWorkerDeploymentVerification,
  verifyWorkerDeploymentWithRetry,
} from './verify-worker-deployment.mjs';

const GIT_SHA = 'a'.repeat(40);
const ACCOUNT_ID = 'b'.repeat(32);
const API_TOKEN = 'sensitive-api-token';
const API_VERSION_ID = '11111111-1111-4111-8111-111111111111';
const WEB_VERSION_ID = '22222222-2222-4222-8222-222222222222';
const DEPLOYMENT_ID = '33333333-3333-4333-8333-333333333333';
const OLDER_DEPLOYMENT_ID = '44444444-4444-4444-8444-444444444444';
const OLDER_VERSION_ID = '55555555-5555-4555-8555-555555555555';
const API_URL = 'https://hereisorder.liorium.workers.dev';
const WEB_URL = 'https://hereisorder-web.liorium.workers.dev';
const NOW = '2026-07-13T17:00:00.000Z';
const SESSION_TIME = '2026-07-13T16:58:00.000Z';
const DEPLOY_TIME = '2026-07-13T16:59:00.000Z';

function wranglerRecords({
  target = 'api',
  session = {},
  deploy = {},
} = {}) {
  const web = target === 'web';
  return [
    {
      type: 'wrangler-session',
      version: 1,
      wrangler_version: '4.110.0',
      command_line_args: ['deploy', '--message', GIT_SHA, '--strict'],
      log_file_path: '/tmp/sensitive-wrangler-log.txt',
      timestamp: SESSION_TIME,
      ...session,
    },
    {
      type: 'deploy',
      version: 1,
      worker_name: web ? 'hereisorder-web' : 'hereisorder',
      worker_tag: 'sensitive-worker-tag',
      version_id: web ? WEB_VERSION_ID : API_VERSION_ID,
      targets: [web ? WEB_URL : API_URL],
      worker_name_overridden: false,
      timestamp: DEPLOY_TIME,
      ...deploy,
    },
  ];
}

function wranglerOutput(options) {
  return `${wranglerRecords(options).map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function deployment({
  id = DEPLOYMENT_ID,
  versionId = API_VERSION_ID,
  createdOn = '2026-07-13T16:59:10.123456Z',
  percentage = 100,
  message = GIT_SHA,
  versions,
  annotations,
  extra = {},
} = {}) {
  return {
    id,
    created_on: createdOn,
    source: 'wrangler',
    strategy: 'percentage',
    author_email: 'sensitive-author@example.com',
    versions: versions ?? [{ version_id: versionId, percentage }],
    annotations: annotations ?? {
      'workers/message': message,
      'workers/triggered_by': 'upload',
    },
    ...extra,
  };
}

function deploymentEnvelope(options) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      deployments: [deployment(options)],
    },
  };
}

function versionEnvelope({
  versionId = API_VERSION_ID,
  message = GIT_SHA,
  annotations,
} = {}) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      id: versionId,
      number: 42,
      metadata: {
        author_email: 'sensitive-author@example.com',
        created_on: '2026-07-13T16:59:00.000Z',
      },
      annotations: annotations ?? {
        'workers/message': message,
        'workers/tag': 'sensitive-tag',
      },
      resources: {
        bindings: [{ name: 'SECRET_BINDING', type: 'secret_text' }],
      },
    },
  };
}

function jsonResponse(value, { ok = true } = {}) {
  return {
    ok,
    async json() {
      return value;
    },
  };
}

function validEnv({ target = 'api', eventName = 'push' } = {}) {
  return {
    CI: 'true',
    GITHUB_EVENT_NAME: eventName,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: GIT_SHA,
    GITHUB_RUN_ID: '29270000000',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_STEP_SUMMARY: `/tmp/${target}-summary`,
    GITHUB_OUTPUT: `/tmp/${target}-output`,
    WRANGLER_OUTPUT_FILE_PATH: `/tmp/${target}-wrangler-output.ndjson`,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: API_TOKEN,
  };
}

function verifiedState({ target = 'api' } = {}) {
  return {
    deploymentId: DEPLOYMENT_ID,
    versionId: target === 'web' ? WEB_VERSION_ID : API_VERSION_ID,
    trafficPercentage: 100,
  };
}

function reportInput({ target = 'api' } = {}) {
  const web = target === 'web';
  return {
    executedAt: NOW,
    gitSha: GIT_SHA,
    runId: '29270000000',
    runAttempt: 1,
    target,
    workerName: web ? 'hereisorder-web' : 'hereisorder',
    deploymentId: DEPLOYMENT_ID,
    versionId: web ? WEB_VERSION_ID : API_VERSION_ID,
    trafficPercentage: 100,
    deploymentUrl: web ? WEB_URL : API_URL,
  };
}

test('getWorkerTarget은 api/web의 Worker, config, working directory를 고정한다', () => {
  const api = getWorkerTarget('api');
  const web = getWorkerTarget('web');

  assert.deepEqual(api, {
    target: 'api',
    workerName: 'hereisorder',
    configPath: 'wrangler.toml',
    workingDirectory: '.',
  });
  assert.deepEqual(web, {
    target: 'web',
    workerName: 'hereisorder-web',
    configPath: 'wrangler.jsonc',
    workingDirectory: 'frontend',
  });
  assert.equal(Object.isFrozen(api), true);
  assert.equal(Object.isFrozen(web), true);
  for (const target of [
    'preview',
    'api ',
    '__proto__',
    'constructor',
    'toString',
    null,
  ]) {
    assert.throws(() => getWorkerTarget(target), /target/);
  }
});

test('parseWranglerDeployEvidence는 exact Wrangler session과 deploy 한 건만 whitelist한다', () => {
  const api = parseWranglerDeployEvidence({
    contents: wranglerOutput(),
    target: 'api',
    gitSha: GIT_SHA,
    now: new Date(NOW),
  });
  const web = parseWranglerDeployEvidence({
    contents: wranglerOutput({ target: 'web' }),
    target: 'web',
    gitSha: GIT_SHA,
    now: new Date(NOW),
  });

  assert.deepEqual(api, {
    target: 'api',
    workerName: 'hereisorder',
    versionId: API_VERSION_ID,
    deploymentUrl: API_URL,
  });
  assert.deepEqual(web, {
    target: 'web',
    workerName: 'hereisorder-web',
    versionId: WEB_VERSION_ID,
    deploymentUrl: WEB_URL,
  });
  assert.equal(Object.isFrozen(api), true);
  const serialized = JSON.stringify(api);
  assert.equal(serialized.includes('sensitive-wrangler'), false);
  assert.equal(serialized.includes('sensitive-worker-tag'), false);
});

test('parseWranglerDeployEvidence는 malformed/duplicate/extra NDJSON record를 거부한다', () => {
  const [session, deploy] = wranglerRecords();
  const invalid = [
    '',
    '{}\n',
    '{not-json}\n',
    `${JSON.stringify(session)}\n`,
    `${JSON.stringify(deploy)}\n`,
    `${JSON.stringify(session)}\n${JSON.stringify(session)}\n${JSON.stringify(deploy)}\n`,
    `${JSON.stringify(session)}\n\n${JSON.stringify(deploy)}\n`,
    `${JSON.stringify(deploy)}\n${JSON.stringify(session)}\n`,
    `${'x'.repeat(64 * 1024)}\n`,
  ];

  for (const contents of invalid) {
    assert.throws(() => parseWranglerDeployEvidence({
      contents,
      target: 'api',
      gitSha: GIT_SHA,
      now: new Date(NOW),
    }), /Wrangler deploy evidence/);
  }
});

test('parseWranglerDeployEvidence는 pinned version과 exact deploy message args를 강제한다', () => {
  const invalidSession = [
    { wrangler_version: '4.109.0' },
    { version: 2 },
    { log_file_path: undefined },
    { unexpected_output_field: 'drift' },
    { command_line_args: ['deploy', '--strict', '--message', GIT_SHA] },
    { command_line_args: ['deploy', '--message', GIT_SHA] },
    { command_line_args: ['deploy', '--message', GIT_SHA, '--strict', '--name', 'hereisorder'] },
    { command_line_args: ['deploy', '--message', 'c'.repeat(40), '--strict'] },
  ];

  for (const session of invalidSession) {
    assert.throws(() => parseWranglerDeployEvidence({
      contents: wranglerOutput({ session }),
      target: 'api',
      gitSha: GIT_SHA,
      now: new Date(NOW),
    }), /Wrangler deploy evidence/);
  }
});

test('parseWranglerDeployEvidence는 fixed Worker, UUID, clean workers.dev origin을 강제한다', () => {
  const invalidDeploy = [
    { worker_name: 'other-worker' },
    { worker_tag: undefined },
    { worker_tag: '' },
    { worker_tag: ' tag' },
    { worker_tag: 'tag\nsecret' },
    { worker_tag: {} },
    { worker_tag: 'x'.repeat(257) },
    { unexpected_output_field: 'drift' },
    { version_id: null },
    { version_id: 'not-a-uuid' },
    { version_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { targets: [] },
    { targets: [API_URL, 'https://second.example.com'] },
    { targets: ['http://hereisorder.liorium.workers.dev'] },
    { targets: ['https://user:password@hereisorder.liorium.workers.dev'] },
    { targets: ['https://hereisorder.liorium.workers.dev:8443'] },
    { targets: ['https://hereisorder.liorium.workers.dev/path'] },
    { targets: ['https://hereisorder.liorium.workers.dev?query=secret'] },
    { targets: ['https://hereisorder.liorium.workers.dev#fragment'] },
    { targets: ['https://other-worker.liorium.workers.dev'] },
    { targets: ['https://hereisorder.example.com'] },
    { worker_name_overridden: true },
  ];

  for (const deploy of invalidDeploy) {
    assert.throws(() => parseWranglerDeployEvidence({
      contents: wranglerOutput({ deploy }),
      target: 'api',
      gitSha: GIT_SHA,
      now: new Date(NOW),
    }), /Wrangler deploy evidence/);
  }
});

test('parseWranglerDeployEvidence는 stale/future/reversed session을 거부한다', () => {
  const invalid = [
    { session: { timestamp: '2026-07-13T16:20:00.000Z' }, deploy: { timestamp: '2026-07-13T16:21:00.000Z' } },
    { session: { timestamp: '2026-07-13T17:00:10.000Z' }, deploy: { timestamp: '2026-07-13T17:00:11.000Z' } },
    { session: { timestamp: DEPLOY_TIME }, deploy: { timestamp: SESSION_TIME } },
    { session: { timestamp: 'not-a-time' } },
  ];

  for (const value of invalid) {
    assert.throws(() => parseWranglerDeployEvidence({
      contents: wranglerOutput(value),
      target: 'api',
      gitSha: GIT_SHA,
      now: new Date(NOW),
    }), /Wrangler deploy evidence/);
  }
});

test('parseVerifiedActiveDeployment는 newest single 100% version과 deployment message를 대조한다', () => {
  const result = {
    deployments: [
      deployment({
        id: OLDER_DEPLOYMENT_ID,
        versionId: OLDER_VERSION_ID,
        createdOn: '2026-07-13T15:00:00.000Z',
        message: 'c'.repeat(40),
      }),
      deployment(),
    ],
  };

  const parsed = parseVerifiedActiveDeployment({
    result,
    expectedVersionId: API_VERSION_ID,
    gitSha: GIT_SHA,
  });
  assert.deepEqual(parsed, verifiedState());
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(JSON.stringify(parsed).includes('sensitive-author'), false);
});

test('parseVerifiedActiveDeployment는 split/stale/mismatched/ambiguous deployment를 거부한다', () => {
  const invalid = [
    null,
    {},
    { deployments: [] },
    { deployments: [deployment({ versionId: OLDER_VERSION_ID })] },
    { deployments: [deployment({ message: 'c'.repeat(40) })] },
    { deployments: [deployment({ annotations: {} })] },
    {
      deployments: [deployment({
        versions: [
          { version_id: API_VERSION_ID, percentage: 50 },
          { version_id: OLDER_VERSION_ID, percentage: 50 },
        ],
      })],
    },
    {
      deployments: [
        deployment(),
        deployment({ createdOn: '2026-07-13T16:59:10.123456Z' }),
      ],
    },
    {
      deployments: [
        deployment(),
        deployment({
          id: OLDER_DEPLOYMENT_ID,
          versionId: OLDER_VERSION_ID,
          createdOn: '2026-07-13T16:59:10.123456Z',
          message: 'c'.repeat(40),
        }),
      ],
    },
  ];

  for (const result of invalid) {
    assert.throws(() => parseVerifiedActiveDeployment({
      result,
      expectedVersionId: API_VERSION_ID,
      gitSha: GIT_SHA,
    }), /active Worker deployment/);
  }
});

test('parseVerifiedWorkerVersion은 exact REST version id와 version message만 투영한다', () => {
  const parsed = parseVerifiedWorkerVersion({
    result: versionEnvelope().result,
    expectedVersionId: API_VERSION_ID,
    gitSha: GIT_SHA,
  });
  assert.deepEqual(parsed, { versionId: API_VERSION_ID });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(JSON.stringify(parsed).includes('SECRET_BINDING'), false);

  const invalid = [
    null,
    {},
    versionEnvelope({ versionId: OLDER_VERSION_ID }).result,
    versionEnvelope({ message: 'c'.repeat(40) }).result,
    versionEnvelope({ annotations: {} }).result,
  ];
  for (const result of invalid) {
    assert.throws(() => parseVerifiedWorkerVersion({
      result,
      expectedVersionId: API_VERSION_ID,
      gitSha: GIT_SHA,
    }), /Worker version/);
  }
});

test('readVerifiedWorkerDeployment는 fixed Worker의 deployments와 exact version을 GET한다', async () => {
  const requests = [];
  const responses = [
    jsonResponse(deploymentEnvelope()),
    jsonResponse(versionEnvelope()),
  ];
  const result = await readVerifiedWorkerDeployment({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    target: 'api',
    expectedVersionId: API_VERSION_ID,
    gitSha: GIT_SHA,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return responses.shift();
    },
  });

  assert.deepEqual(result, verifiedState());
  assert.deepEqual(requests.map(({ url }) => url), [
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/hereisorder/deployments`,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/hereisorder/versions/${API_VERSION_ID}`,
  ]);
  for (const { options } of requests) {
    assert.equal(options.method, 'GET');
    assert.deepEqual(options.headers, { Authorization: `Bearer ${API_TOKEN}` });
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('readVerifiedWorkerDeployment는 HTTP/JSON/envelope/transport/version 오류를 sanitize한다', async () => {
  const failures = [
    async () => jsonResponse({ success: false, errors: [{ message: 'sensitive-http' }] }, { ok: false }),
    async () => ({
      ok: true,
      async json() {
        throw new Error('sensitive-json');
      },
    }),
    async () => jsonResponse({ success: false, result: deploymentEnvelope().result }),
    async () => {
      throw new Error('sensitive-transport');
    },
    (() => {
      let count = 0;
      return async () => {
        count += 1;
        return count === 1
          ? jsonResponse(deploymentEnvelope())
          : jsonResponse(versionEnvelope({ message: 'sensitive-version' }));
      };
    })(),
  ];

  for (const fetchImpl of failures) {
    await assert.rejects(
      readVerifiedWorkerDeployment({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        target: 'api',
        expectedVersionId: API_VERSION_ID,
        gitSha: GIT_SHA,
        fetchImpl,
      }),
      (error) => error.message === 'Cloudflare Worker deployment verification request failed.'
        && !error.message.includes('sensitive'),
    );
  }
});

test('verifyWorkerDeploymentWithRetry는 read-only 검증만 유한 재시도하고 중간 evidence를 출력하지 않는다', async () => {
  let attempts = 0;
  const sleeps = [];
  const logs = [];
  const result = await verifyWorkerDeploymentWithRetry({
    readAttempt: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`sensitive-attempt-${attempts}`);
      return verifiedState();
    },
    maxAttempts: 3,
    retryDelayMs: 25,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    log: (value) => logs.push(value),
  });

  assert.deepEqual(result, verifiedState());
  assert.equal(attempts, 3);

  await assert.rejects(
    verifyWorkerDeploymentWithRetry({
      readAttempt: async () => {
        throw new Error('sensitive-read');
      },
      maxAttempts: 2,
      retryDelayMs: 1,
      sleep: async () => {
        throw new Error('sensitive-sleep');
      },
    }),
    (error) => error.message === 'Worker deployment did not become active.'
      && !error.message.includes('sensitive'),
  );
  assert.deepEqual(sleeps, [25, 25]);
  assert.deepEqual(logs, []);

  attempts = 0;
  await assert.rejects(
    verifyWorkerDeploymentWithRetry({
      readAttempt: async () => {
        attempts += 1;
        throw new Error('sensitive-final-attempt');
      },
      maxAttempts: 3,
      retryDelayMs: 0,
      sleep: async () => {},
    }),
    (error) => error.message === 'Worker deployment did not become active.'
      && !error.message.includes('sensitive'),
  );
  assert.equal(attempts, 3);
});

test('parseDeploymentVerificationEnvironment는 exact main push/dispatch CI metadata를 강제한다', () => {
  for (const eventName of ['push', 'workflow_dispatch']) {
    const parsed = parseDeploymentVerificationEnvironment({
      env: validEnv({ eventName }),
      target: 'api',
    });
    assert.deepEqual(parsed, {
      gitSha: GIT_SHA,
      runId: '29270000000',
      runAttempt: 1,
      accountId: ACCOUNT_ID,
      apiToken: API_TOKEN,
      summaryPath: '/tmp/api-summary',
      outputPath: '/tmp/api-output',
      wranglerOutputPath: '/tmp/api-wrangler-output.ndjson',
    });
    assert.equal(Object.isFrozen(parsed), true);
  }

  const invalid = [
    { CI: 'false' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_SHA: GIT_SHA.toUpperCase() },
    { GITHUB_SHA: 'short' },
    { GITHUB_RUN_ID: '0' },
    { GITHUB_RUN_ID: '01' },
    { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_RUN_ATTEMPT: '1.5' },
    { CLOUDFLARE_ACCOUNT_ID: 'not-an-account-id' },
    { CLOUDFLARE_API_TOKEN: ' token' },
    { CLOUDFLARE_API_TOKEN: 'token\nsecret' },
    { GITHUB_STEP_SUMMARY: 'relative-summary' },
    { GITHUB_OUTPUT: 'relative-output' },
    { WRANGLER_OUTPUT_FILE_PATH: 'relative.ndjson' },
    { WRANGLER_OUTPUT_FILE_PATH: '/tmp/not-ndjson.txt' },
    { GITHUB_OUTPUT: '/tmp/api-summary' },
  ];
  for (const override of invalid) {
    assert.throws(() => parseDeploymentVerificationEnvironment({
      env: { ...validEnv(), ...override },
      target: 'api',
    }), /deployment verification environment/);
  }
  assert.throws(() => parseDeploymentVerificationEnvironment({
    env: validEnv(),
    target: 'preview',
  }), /deployment verification environment/);
});

test('buildWorkerDeploymentReport와 summary는 immutable exact whitelist만 사용한다', () => {
  const report = buildWorkerDeploymentReport(reportInput());
  const expected = {
    verificationVersion: DEPLOYMENT_VERIFICATION_VERSION,
    ...reportInput(),
    outcome: 'verified',
  };

  assert.deepEqual(report, expected);
  assert.deepEqual(Object.keys(report), [
    'verificationVersion',
    'executedAt',
    'gitSha',
    'runId',
    'runAttempt',
    'target',
    'workerName',
    'deploymentId',
    'versionId',
    'trafficPercentage',
    'deploymentUrl',
    'outcome',
  ]);
  assert.equal(Object.isFrozen(report), true);
  assert.throws(() => {
    report.outcome = 'tampered';
  }, TypeError);

  const summary = renderWorkerDeploymentSummary(report);
  assert.match(summary, /^## Worker active version verification\n\n```json\n/);
  assert.equal(summary.endsWith('\n```\n'), true);
  assert.equal(summary.includes(API_TOKEN), false);
  assert.equal(summary.includes('sensitive-author'), false);
  assert.deepEqual(JSON.parse(summary.match(/```json\n([\s\S]+)\n```/)[1]), expected);

  assert.throws(() => buildWorkerDeploymentReport({
    ...reportInput(),
    secret: API_TOKEN,
  }), /deployment verification report/);
  assert.equal(renderWorkerDeploymentSummary({ ...report }), summary);
  assert.throws(() => renderWorkerDeploymentSummary({
    ...report,
    secret: API_TOKEN,
  }), /deployment verification report/);
});

test('package script는 fixed verifier CLI만 실행한다', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    new URL('../package.json', import.meta.url),
    'utf8',
  ));
  assert.equal(
    packageJson.scripts['deploy:verify-worker'],
    'node scripts/verify-worker-deployment.mjs',
  );
});

test('runWorkerDeploymentVerification은 verified URL output 뒤 whitelist summary/log를 남긴다', async () => {
  const events = [];
  const report = await runWorkerDeploymentVerification({
    target: 'api',
    env: validEnv(),
    now: () => new Date(NOW),
    readFile: (filePath) => {
      assert.equal(filePath, '/tmp/api-wrangler-output.ndjson');
      return wranglerOutput();
    },
    verifyActiveVersion: async ({ evidence, environment, target }) => {
      assert.deepEqual(evidence, {
        target: 'api',
        workerName: 'hereisorder',
        versionId: API_VERSION_ID,
        deploymentUrl: API_URL,
      });
      assert.equal(environment.accountId, ACCOUNT_ID);
      assert.equal(target.workerName, 'hereisorder');
      return verifiedState();
    },
    appendSummary: async (filePath, contents) => events.push(['summary', filePath, contents]),
    appendOutput: async (filePath, contents) => events.push(['output', filePath, contents]),
    log: async (contents) => events.push(['log', contents]),
  });

  assert.deepEqual(report, {
    verificationVersion: DEPLOYMENT_VERIFICATION_VERSION,
    ...reportInput(),
    outcome: 'verified',
  });
  assert.deepEqual(events.map(([event]) => event), ['output', 'summary', 'log']);
  assert.equal(events[0][1], '/tmp/api-output');
  assert.equal(events[0][2], `deployment-url=${API_URL}\n`);
  assert.deepEqual(JSON.parse(events[2][1]), report);
  assert.equal(JSON.stringify(events).includes(API_TOKEN), false);
  assert.equal(JSON.stringify(events).includes('sensitive-worker-tag'), false);
});

test('runWorkerDeploymentVerification은 output 실패 시 summary/log 없이 sanitize한다', async () => {
  const summaries = [];
  const logs = [];
  await assert.rejects(
    runWorkerDeploymentVerification({
      target: 'api',
      env: validEnv(),
      now: () => new Date(NOW),
      readFile: () => wranglerOutput(),
      verifyActiveVersion: async () => verifiedState(),
      appendOutput: async () => {
        throw new Error('sensitive-output-path');
      },
      appendSummary: async (...args) => summaries.push(args),
      log: async (...args) => logs.push(args),
    }),
    (error) => error.message === 'Worker deployment verification failed.'
      && !error.message.includes('sensitive'),
  );
  assert.deepEqual(summaries, []);
  assert.deepEqual(logs, []);
});

test('runWorkerDeploymentVerification은 summary 실패 시 success log 없이 sanitize한다', async () => {
  const outputs = [];
  const logs = [];
  await assert.rejects(
    runWorkerDeploymentVerification({
      target: 'api',
      env: validEnv(),
      now: () => new Date(NOW),
      readFile: () => wranglerOutput(),
      verifyActiveVersion: async () => verifiedState(),
      appendSummary: async () => {
        throw new Error('sensitive-summary-path');
      },
      appendOutput: async (...args) => outputs.push(args),
      log: async (...args) => logs.push(args),
    }),
    (error) => error.message === 'Worker deployment verification failed.'
      && !error.message.includes('sensitive'),
  );
  assert.deepEqual(outputs, [[
    '/tmp/api-output',
    `deployment-url=${API_URL}\n`,
  ]]);
  assert.deepEqual(logs, []);
});
