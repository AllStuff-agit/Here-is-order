import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  promptHidden,
  readProductionD1Binding,
  runPasswordRecovery,
} from './recover-password.mjs';

const API_TOKEN = 'recovery-api-token';
const ACCOUNT_ID = 'recovery-account-id';
const DATABASE_NAME = 'hereisorder';
const DATABASE_ID = 'production-database-id';
const USERNAME = 'admin';
const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = 'pbkdf2_sha256$100000$sensitive-salt$sensitive-hash';

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function writeConfig(root, contents = `[[d1_databases]]
binding = "DB"
database_name = "${DATABASE_NAME}"
database_id = "${DATABASE_ID}"
`) {
  const configPath = path.join(root, 'wrangler.toml');
  fs.writeFileSync(configPath, contents);
  return configPath;
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-recovery-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function successEnvelope(result) {
  return { success: true, result };
}

function makeRecoveryFetch({
  username = USERNAME,
  preflightResults,
  writeResults = [
    { success: true, results: [], meta: { changes: 1 } },
    { success: true, results: [], meta: { changes: 2 } },
    { success: true, results: [], meta: { changes: 1 } },
  ],
  postflightResults,
  postflightRow = {
    username,
    hash_scheme_ok: 1,
    session_count: 0,
    latest_recovery_audit: JSON.stringify({ source: 'operator_recovery', username }),
  },
} = {}) {
  const resolvedPreflightResults = preflightResults ?? [{
    success: true,
    results: [{ id: 1, username }],
    meta: {},
  }];
  const resolvedPostflightResults = postflightResults ?? [{
    success: true,
    results: [postflightRow],
    meta: {},
  }];
  const requests = [];
  const responseBodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, init, body });
    let envelope;
    if (Object.hasOwn(body, 'batch')) {
      envelope = successEnvelope(writeResults);
    } else if (/^SELECT id, username FROM users/.test(body.sql)) {
      envelope = successEnvelope(resolvedPreflightResults);
    } else {
      envelope = successEnvelope(resolvedPostflightResults);
    }
    responseBodies.push(envelope);
    return jsonResponse(envelope);
  };
  return { fetchImpl, requests, responseBodies };
}

function makeTty({ initiallyRaw = false } = {}) {
  const input = new PassThrough();
  const rawModes = [];
  let pauseCalls = 0;
  input.isTTY = true;
  input.isRaw = initiallyRaw;
  input.setRawMode = (enabled) => {
    rawModes.push(enabled);
    input.isRaw = enabled;
    return input;
  };
  const originalPause = input.pause.bind(input);
  input.pause = () => {
    pauseCalls += 1;
    return originalPause();
  };
  const writes = [];
  return {
    input,
    output: { write(value) { writes.push(String(value)); } },
    rawModes,
    writes,
    get pauseCalls() { return pauseCalls; },
  };
}

function assertTtyClean(tty, { initiallyRaw = false } = {}) {
  assert.equal(tty.input.listenerCount('data'), 0);
  assert.equal(tty.input.listenerCount('end'), 0);
  assert.equal(tty.input.listenerCount('error'), 0);
  assert.ok(tty.pauseCalls >= 1);
  assert.equal(tty.input.isPaused(), true);
  assert.equal(tty.input.isRaw, initiallyRaw);
  assert.deepEqual(tty.rawModes, initiallyRaw ? [true] : [true, false]);
}

test('readProductionD1Binding은 정확히 하나인 DB binding만 반환한다', (t) => {
  const root = makeRoot(t);
  const configPath = writeConfig(root, `[[d1_databases]]
binding = "ANALYTICS"
database_name = "analytics"
database_id = "analytics-id"

[[d1_databases]]
binding = "DB"
database_name = "hereisorder"
database_id = "db-id"
`);
  assert.deepEqual(readProductionD1Binding({ configPath }), {
    binding: 'DB',
    databaseName: 'hereisorder',
    databaseId: 'db-id',
  });

  fs.writeFileSync(configPath, 'name = "worker-without-d1"\n');
  assert.throws(() => readProductionD1Binding({ configPath }), /정확히 하나/);

  fs.writeFileSync(configPath, `[[d1_databases]]
binding = "DB"
database_name = "one"
database_id = "one-id"
[[d1_databases]]
binding = "DB"
database_name = "two"
database_id = "two-id"
`);
  assert.throws(() => readProductionD1Binding({ configPath }), /정확히 하나/);

  fs.writeFileSync(configPath, `[[d1_databases]]
binding = "DB"
database_name = "missing-id"
`);
  assert.throws(() => readProductionD1Binding({ configPath }), /정확히 하나/);
});

test('args와 secrets가 유효하지 않으면 fetch, prompt, config read를 하지 않는다', async (t) => {
  const root = makeRoot(t);
  const missingConfig = path.join(root, 'does-not-exist.toml');
  let fetchCalls = 0;
  let questionCalls = 0;
  let hiddenCalls = 0;
  const dependencies = {
    configPath: missingConfig,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    question: async () => { questionCalls += 1; return ''; },
    hiddenPrompt: async () => { hiddenCalls += 1; return ''; },
    output: { write() {} },
  };

  await assert.rejects(
    runPasswordRecovery({ ...dependencies, argv: [], env: {} }),
    /--remote/,
  );
  await assert.rejects(
    runPasswordRecovery({ ...dependencies, argv: ['--remote'], env: {} }),
    /--username/,
  );
  await assert.rejects(
    runPasswordRecovery({
      ...dependencies,
      argv: ['--remote', '--username', USERNAME],
      env: {},
    }),
    /CLOUDFLARE_API_TOKEN과 CLOUDFLARE_ACCOUNT_ID/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(questionCalls, 0);
  assert.equal(hiddenCalls, 0);
});

test('exact confirmation 전에는 mutation batch를 보내지 않는다', async (t) => {
  const root = makeRoot(t);
  const configPath = writeConfig(root, `[[d1_databases]]
binding = "DB"
database_name = "hereisorder"
database_id = "db-id"
`);
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return new Response(JSON.stringify({
      success: true,
      result: [{ success: true, results: [{ id: 1, username: 'admin' }], meta: {} }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(
    runPasswordRecovery({
      argv: ['--remote', '--username', 'admin'],
      env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
      fetchImpl,
      configPath,
      question: async () => 'wrong confirmation',
      hiddenPrompt: async () => assert.fail('password prompt must not run'),
      output: { write() {} },
    }),
    /확인 문구/,
  );
  assert.equal(bodies.length, 1);
  assert.equal(Object.hasOwn(bodies[0], 'batch'), false);
});

test('두 hidden entry와 password validation이 끝나기 전에는 mutation하지 않는다', async (t) => {
  const root = makeRoot(t);
  const configPath = writeConfig(root);
  const { fetchImpl, requests } = makeRecoveryFetch();
  const hiddenValues = [PASSWORD, `${PASSWORD}!different`];
  let hiddenCalls = 0;

  await assert.rejects(
    runPasswordRecovery({
      argv: ['--remote', '--username', USERNAME],
      env: { CLOUDFLARE_API_TOKEN: API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      fetchImpl,
      configPath,
      question: async () => `RECOVER ${DATABASE_NAME} ${USERNAME}`,
      hiddenPrompt: async () => hiddenValues[hiddenCalls++],
      output: { write() {} },
    }),
    /확인이 일치하지 않습니다/,
  );

  assert.equal(hiddenCalls, 2);
  assert.equal(requests.length, 1);
  assert.equal(Object.hasOwn(requests[0].body, 'batch'), false);
});

test('quote username은 SQL/URL이 아니라 REST params에만 있고 secret은 출력하지 않는다', async (t) => {
  const root = makeRoot(t);
  const configPath = writeConfig(root);
  const username = "admin' OR 1=1 --";
  const { fetchImpl, requests, responseBodies } = makeRecoveryFetch({ username });
  const output = [];
  let questionPrompt;
  let hiddenCalls = 0;

  await runPasswordRecovery({
    argv: ['--remote', '--username', username],
    env: { CLOUDFLARE_API_TOKEN: API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    fetchImpl,
    configPath,
    question: async ({ prompt }) => {
      questionPrompt = prompt;
      return `RECOVER ${DATABASE_NAME} ${username}`;
    },
    hiddenPrompt: async () => {
      hiddenCalls += 1;
      return PASSWORD;
    },
    createHash: () => PASSWORD_HASH,
    output: { write(value) { output.push(String(value)); } },
  });

  assert.equal(hiddenCalls, 2);
  assert.match(questionPrompt, /RECOVER hereisorder/);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.ok(!request.url.includes(username));
    assert.ok(!request.url.includes(PASSWORD));
    assert.ok(!request.url.includes(PASSWORD_HASH));
    const statements = request.body.batch ?? [request.body];
    for (const statement of statements) {
      assert.ok(!statement.sql.includes(username));
      assert.ok(!statement.sql.includes(PASSWORD));
      assert.ok(!statement.sql.includes(PASSWORD_HASH));
    }
  }
  assert.deepEqual(requests[0].body.params, [username]);
  assert.equal(requests[1].body.batch.every(({ params }) => params.includes(username)
    || params.some((value) => typeof value === 'string' && value.includes(username))), true);
  assert.equal(requests[2].body.params.at(-1), username);

  const outputText = output.join('');
  assert.doesNotMatch(outputText, new RegExp(PASSWORD.replaceAll('$', '\\$&')));
  assert.ok(!outputText.includes(PASSWORD_HASH));
  assert.ok(!outputText.includes(API_TOKEN));
  assert.ok(!outputText.includes(ACCOUNT_ID));
  assert.ok(!JSON.stringify(responseBodies[2]).includes(PASSWORD));
  assert.ok(!JSON.stringify(responseBodies[2]).includes(PASSWORD_HASH));
});

test('같은 password recovery도 매번 다른 random salt hash를 전송한다', async (t) => {
  const root = makeRoot(t);
  const configPath = writeConfig(root);
  const hashes = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { fetchImpl, requests } = makeRecoveryFetch();
    await runPasswordRecovery({
      argv: ['--remote', '--username', USERNAME],
      env: { CLOUDFLARE_API_TOKEN: API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      fetchImpl,
      configPath,
      question: async () => `RECOVER ${DATABASE_NAME} ${USERNAME}`,
      hiddenPrompt: async () => PASSWORD,
      output: { write() {} },
    });
    hashes.push(requests[1].body.batch[0].params[0]);
  }

  assert.match(hashes[0], /^pbkdf2_sha256\$100000\$/);
  assert.match(hashes[1], /^pbkdf2_sha256\$100000\$/);
  assert.notEqual(hashes[0], hashes[1]);
});

test('preflight의 missing/extra statement와 row는 mutation과 completion 전에 거부한다', async (t) => {
  const root = makeRoot(t);
  const configPath = writeConfig(root);
  const validStatement = {
    success: true,
    results: [{ id: 1, username: USERNAME }],
    meta: {},
  };
  const scenarios = [
    { name: 'missing statement', preflightResults: [] },
    {
      name: 'extra statement',
      preflightResults: [validStatement, structuredClone(validStatement)],
    },
    {
      name: 'missing row',
      preflightResults: [{ ...validStatement, results: [] }],
    },
    {
      name: 'extra row',
      preflightResults: [{
        ...validStatement,
        results: [
          { id: 1, username: USERNAME },
          { id: 2, username: USERNAME },
        ],
      }],
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { fetchImpl, requests } = makeRecoveryFetch({
        preflightResults: scenario.preflightResults,
      });
      const output = [];
      let questionCalls = 0;
      let hiddenCalls = 0;

      await assert.rejects(
        runPasswordRecovery({
          argv: ['--remote', '--username', USERNAME],
          env: { CLOUDFLARE_API_TOKEN: API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
          fetchImpl,
          configPath,
          question: async () => {
            questionCalls += 1;
            return `RECOVER ${DATABASE_NAME} ${USERNAME}`;
          },
          hiddenPrompt: async () => {
            hiddenCalls += 1;
            return PASSWORD;
          },
          createHash: () => PASSWORD_HASH,
          output: { write(value) { output.push(String(value)); } },
        }),
        /active admin/,
      );

      assert.equal(requests.length, 1);
      assert.equal(Object.hasOwn(requests[0].body, 'batch'), false);
      assert.equal(questionCalls, 0);
      assert.equal(hiddenCalls, 0);
      assert.doesNotMatch(output.join(''), /Password recovery completed/);
    });
  }
});

test('postflight의 missing/extra statement와 row 및 username mismatch는 completion을 거부한다', async (t) => {
  const root = makeRoot(t);
  const configPath = writeConfig(root);
  const auditJson = JSON.stringify({ source: 'operator_recovery', username: USERNAME });
  const validRow = {
    username: USERNAME,
    hash_scheme_ok: 1,
    session_count: 0,
    latest_recovery_audit: auditJson,
  };
  const validStatement = { success: true, results: [validRow], meta: {} };
  const scenarios = [
    { name: 'missing statement', postflightResults: [] },
    {
      name: 'extra statement',
      postflightResults: [validStatement, structuredClone(validStatement)],
    },
    {
      name: 'missing row',
      postflightResults: [{ ...validStatement, results: [] }],
    },
    {
      name: 'extra row',
      postflightResults: [{
        ...validStatement,
        results: [validRow, structuredClone(validRow)],
      }],
    },
    {
      name: 'username mismatch',
      postflightResults: [{
        ...validStatement,
        results: [{ ...validRow, username: 'other-admin' }],
      }],
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { fetchImpl, requests } = makeRecoveryFetch({
        postflightResults: scenario.postflightResults,
      });
      const output = [];

      await assert.rejects(
        runPasswordRecovery({
          argv: ['--remote', '--username', USERNAME],
          env: { CLOUDFLARE_API_TOKEN: API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
          fetchImpl,
          configPath,
          question: async () => `RECOVER ${DATABASE_NAME} ${USERNAME}`,
          hiddenPrompt: async () => PASSWORD,
          createHash: () => PASSWORD_HASH,
          output: { write(value) { output.push(String(value)); } },
        }),
        (error) => {
          assert.match(error.message, /postflight/);
          assert.ok(!error.message.includes(PASSWORD));
          assert.ok(!error.message.includes(PASSWORD_HASH));
          assert.ok(!error.message.includes(API_TOKEN));
          assert.ok(!error.message.includes(ACCOUNT_ID));
          return true;
        },
      );

      assert.equal(requests.length, 3);
      assert.doesNotMatch(output.join(''), /Password recovery completed/);
    });
  }
});

test('write/postflight의 changes, success, session, scheme, audit mismatch를 거부한다', async (t) => {
  const root = makeRoot(t);
  const configPath = writeConfig(root);
  const auditJson = JSON.stringify({ source: 'operator_recovery', username: USERNAME });
  const verifiedRow = {
    username: USERNAME,
    hash_scheme_ok: 1,
    session_count: 0,
    latest_recovery_audit: auditJson,
  };
  const cases = [
    {
      name: 'update changes',
      options: {
        writeResults: [
          { success: true, meta: { changes: 0 } },
          { success: true, meta: {} },
          { success: true, meta: {} },
        ],
      },
      pattern: /정확히 한 admin/,
    },
    ...[true, '1', null].map((changes) => ({
      name: `update changes type ${String(changes)}`,
      options: {
        writeResults: [
          { success: true, meta: { changes } },
          { success: true, meta: {} },
          { success: true, meta: {} },
        ],
      },
      pattern: /정확히 한 admin/,
    })),
    {
      name: 'statement success',
      options: {
        writeResults: [
          { success: true, meta: { changes: 1 } },
          { success: false, meta: {} },
          { success: true, meta: {} },
        ],
      },
      pattern: /fully succeed/,
    },
    {
      name: 'session count',
      options: { postflightRow: { ...verifiedRow, session_count: 1 } },
      pattern: /postflight/,
    },
    {
      name: 'hash scheme',
      options: { postflightRow: { ...verifiedRow, hash_scheme_ok: 0 } },
      pattern: /postflight/,
    },
    ...[true, '1', null].map((hashScheme) => ({
      name: `hash scheme type ${String(hashScheme)}`,
      options: { postflightRow: { ...verifiedRow, hash_scheme_ok: hashScheme } },
      pattern: /postflight/,
    })),
    ...[null, '0', false].map((sessionCount) => ({
      name: `session count type ${String(sessionCount)}`,
      options: { postflightRow: { ...verifiedRow, session_count: sessionCount } },
      pattern: /postflight/,
    })),
    {
      name: 'audit fact',
      options: { postflightRow: { ...verifiedRow, latest_recovery_audit: '{}' } },
      pattern: /audit fact/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { fetchImpl } = makeRecoveryFetch(scenario.options);
      const output = [];
      await assert.rejects(
        runPasswordRecovery({
          argv: ['--remote', '--username', USERNAME],
          env: { CLOUDFLARE_API_TOKEN: API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
          fetchImpl,
          configPath,
          question: async () => `RECOVER ${DATABASE_NAME} ${USERNAME}`,
          hiddenPrompt: async () => PASSWORD,
          createHash: () => PASSWORD_HASH,
          output: { write(value) { output.push(String(value)); } },
        }),
        (error) => {
          assert.match(error.message, scenario.pattern);
          assert.ok(!error.message.includes(PASSWORD));
          assert.ok(!error.message.includes(PASSWORD_HASH));
          assert.ok(!error.message.includes(API_TOKEN));
          assert.ok(!error.message.includes(ACCOUNT_ID));
          return true;
        },
      );
      assert.doesNotMatch(output.join(''), /Password recovery completed/);
    });
  }
});

test('promptHidden은 split UTF-8, Unicode backspace, newline을 처리하고 입력을 복구한다', async () => {
  const tty = makeTty();
  const resultPromise = promptHidden({
    input: tty.input,
    output: tty.output,
    prompt: 'New password: ',
  });
  const first = Buffer.from('한');
  tty.input.write(first.subarray(0, 1));
  tty.input.write(first.subarray(1));
  tty.input.write(Buffer.from('😀'));
  tty.input.write(Buffer.from('\u007f'));
  tty.input.write(Buffer.from('글\r'));

  assert.equal(await resultPromise, '한글');
  assert.deepEqual(tty.writes, ['New password: ', '\n']);
  assertTtyClean(tty);
});

test('promptHidden은 Ctrl-C, Ctrl-D, end, error에서 reject하고 항상 TTY를 복구한다', async (t) => {
  const cases = [
    { name: 'Ctrl-C', action: (input) => input.write(Buffer.from('\u0003')), pattern: /취소/ },
    { name: 'Ctrl-D', action: (input) => input.write(Buffer.from('\u0004')), pattern: /종료/ },
    { name: 'end', action: (input) => input.end(), pattern: /종료/ },
    {
      name: 'error',
      action: (input) => input.emit('error', new Error(`${PASSWORD}/${API_TOKEN}`)),
      pattern: /읽을 수 없습니다/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const tty = makeTty();
      const resultPromise = promptHidden({
        input: tty.input,
        output: tty.output,
        prompt: 'Password: ',
      });
      scenario.action(tty.input);
      await assert.rejects(resultPromise, (error) => {
        assert.match(error.message, scenario.pattern);
        assert.ok(!error.message.includes(PASSWORD));
        assert.ok(!error.message.includes(API_TOKEN));
        return true;
      });
      assertTtyClean(tty);
    });
  }
});

test('promptHidden은 기존 raw mode를 유지하고 non-TTY를 즉시 거부한다', async () => {
  const rawTty = makeTty({ initiallyRaw: true });
  const resultPromise = promptHidden({
    input: rawTty.input,
    output: rawTty.output,
    prompt: 'Password: ',
  });
  rawTty.input.write(Buffer.from('secret\n'));
  assert.equal(await resultPromise, 'secret');
  assertTtyClean(rawTty, { initiallyRaw: true });

  const nonTty = new PassThrough();
  await assert.rejects(
    promptHidden({ input: nonTty, output: { write() {} }, prompt: 'Password: ' }),
    /interactive TTY/,
  );
  assert.equal(nonTty.listenerCount('data'), 0);
});
