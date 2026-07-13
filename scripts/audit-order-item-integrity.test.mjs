import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertReadOnlyAuditSql,
  evaluateAuditSummary,
  parseAuditArguments,
  parseWranglerAuditResult,
} from './audit-order-item-integrity.mjs';
import * as auditModule from './audit-order-item-integrity.mjs';

const COUNT_FIELDS = [
  'active_overreceived_rows',
  'deleted_overreceived_rows',
  'active_overreceived_excess_qty',
  'overreceived_orders',
  'masked_orders',
  'invalid_order_item_deletion_flag_rows',
  'active_nonpositive_ordered_rows',
  'active_negative_received_rows',
  'active_duplicate_groups',
  'active_mismatched_ledger_item_rows',
  'active_receipt_ledger_mismatch_rows',
  'active_status_mismatch_orders',
  'active_missing_order_parent_rows',
  'active_deleted_order_parent_rows',
  'active_invalid_order_parent_deletion_flag_rows',
  'active_missing_item_parent_rows',
  'active_deleted_item_parent_rows',
  'active_invalid_item_parent_deletion_flag_rows',
];
const ACTIVE_REPORT_FIELDS = [
  ['active_overreceived_rows', 'activeOverreceivedRows'],
  ['active_overreceived_excess_qty', 'activeOverreceivedExcessQty'],
  ['overreceived_orders', 'overreceivedOrders'],
  ['masked_orders', 'maskedOrders'],
  ['invalid_order_item_deletion_flag_rows', 'invalidOrderItemDeletionFlagRows'],
  ['active_nonpositive_ordered_rows', 'activeNonpositiveOrderedRows'],
  ['active_negative_received_rows', 'activeNegativeReceivedRows'],
  ['active_duplicate_groups', 'activeDuplicateGroups'],
  ['active_mismatched_ledger_item_rows', 'activeMismatchedLedgerItemRows'],
  ['active_receipt_ledger_mismatch_rows', 'activeReceiptLedgerMismatchRows'],
  ['active_status_mismatch_orders', 'activeStatusMismatchOrders'],
  ['active_missing_order_parent_rows', 'activeMissingOrderParentRows'],
  ['active_deleted_order_parent_rows', 'activeDeletedOrderParentRows'],
  [
    'active_invalid_order_parent_deletion_flag_rows',
    'activeInvalidOrderParentDeletionFlagRows',
  ],
  ['active_missing_item_parent_rows', 'activeMissingItemParentRows'],
  ['active_deleted_item_parent_rows', 'activeDeletedItemParentRows'],
  [
    'active_invalid_item_parent_deletion_flag_rows',
    'activeInvalidItemParentDeletionFlagRows',
  ],
];
const SUMMARY_FIELDS = ['query_version', ...COUNT_FIELDS].sort();
const EXECUTED_AT = '2026-07-13T00:00:00.000Z';
const SUMMARY_SQL = fs.readFileSync(
  new URL('./sql/audit-order-item-integrity.sql', import.meta.url),
  'utf8',
);
const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WRANGLER_BIN = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const SUMMARY_SQL_PATH = fileURLToPath(
  new URL('./sql/audit-order-item-integrity.sql', import.meta.url),
);
const INITIAL_MIGRATION_PATH = fileURLToPath(
  new URL('../migrations/001_init.sql', import.meta.url),
);
const INTEGRITY_MIGRATION_PATH = fileURLToPath(
  new URL('../migrations/002_integrity_and_roles.sql', import.meta.url),
);
const LEGACY_FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/order-item-integrity-legacy.sql', import.meta.url),
);
const DETAILS_SQL_PATH = fileURLToPath(
  new URL('./sql/audit-order-item-integrity-details.sql', import.meta.url),
);
const WRANGLER_CONFIG_PATH = fileURLToPath(
  new URL('../wrangler.toml', import.meta.url),
);
const AUDIT_SCRIPT_PATH = fileURLToPath(
  new URL('./audit-order-item-integrity.mjs', import.meta.url),
);

const EXPECTED_DETAIL_FIELDS = [
  'query_version',
  'order_id',
  'order_item_id',
  'item_id',
  'ordered_qty',
  'received_qty',
  'ledger_in_qty',
  'order_item_is_deleted',
  'order_is_deleted',
  'item_is_deleted',
  'stored_status',
  'derived_status',
  'is_over_received',
  'has_nonpositive_ordered',
  'has_negative_received',
  'has_invalid_order_item_deletion_flag',
  'is_active_duplicate',
  'has_mismatched_ledger_item',
  'has_receipt_ledger_mismatch',
  'has_status_mismatch',
  'has_missing_order_parent',
  'has_deleted_order_parent',
  'has_invalid_order_parent_deletion_flag',
  'has_missing_item_parent',
  'has_deleted_item_parent',
  'has_invalid_item_parent_deletion_flag',
  'is_masked_remaining_item',
];
const DETAIL_INTEGER_FIELDS = [
  'order_id',
  'order_item_id',
  'item_id',
  'ordered_qty',
  'received_qty',
  'ledger_in_qty',
  'order_item_is_deleted',
];
const DETAIL_NULLABLE_INTEGER_FIELDS = [
  'order_is_deleted',
  'item_is_deleted',
];
const DETAIL_FLAG_FIELDS = [
  'is_over_received',
  'has_nonpositive_ordered',
  'has_negative_received',
  'has_invalid_order_item_deletion_flag',
  'is_active_duplicate',
  'has_mismatched_ledger_item',
  'has_receipt_ledger_mismatch',
  'has_status_mismatch',
  'has_missing_order_parent',
  'has_deleted_order_parent',
  'has_invalid_order_parent_deletion_flag',
  'has_missing_item_parent',
  'has_deleted_item_parent',
  'has_invalid_item_parent_deletion_flag',
  'is_masked_remaining_item',
];

const SHADOW_SCHEMA_SQL = `
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  is_deleted INTEGER NOT NULL
);
CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  is_deleted INTEGER NOT NULL
);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  ordered_qty INTEGER NOT NULL,
  received_qty INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL
);
CREATE TABLE stock_transactions (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL,
  movement_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  order_item_id INTEGER
);
`;

const cleanRow = {
  query_version: 'order-item-integrity-v1',
  active_overreceived_rows: 0,
  deleted_overreceived_rows: 2,
  active_overreceived_excess_qty: 0,
  overreceived_orders: 0,
  masked_orders: 0,
  invalid_order_item_deletion_flag_rows: 0,
  active_nonpositive_ordered_rows: 0,
  active_negative_received_rows: 0,
  active_duplicate_groups: 0,
  active_mismatched_ledger_item_rows: 0,
  active_receipt_ledger_mismatch_rows: 0,
  active_status_mismatch_orders: 0,
  active_missing_order_parent_rows: 0,
  active_deleted_order_parent_rows: 0,
  active_invalid_order_parent_deletion_flag_rows: 0,
  active_missing_item_parent_rows: 0,
  active_deleted_item_parent_rows: 0,
  active_invalid_item_parent_deletion_flag_rows: 0,
};

function wranglerStdout(row) {
  return JSON.stringify([{ success: true, results: [row], meta: {} }]);
}

function detailWranglerStdout(rows) {
  return JSON.stringify([{ success: true, results: rows, meta: {} }]);
}

function validDetailRow(overrides = {}) {
  return {
    query_version: 'order-item-integrity-v1',
    order_id: 101,
    order_item_id: 1001,
    item_id: 1,
    ordered_qty: 3,
    received_qty: 1,
    ledger_in_qty: 1,
    order_item_is_deleted: 0,
    order_is_deleted: 0,
    item_is_deleted: 0,
    stored_status: 'partially_received',
    derived_status: 'partially_received',
    is_over_received: 0,
    has_nonpositive_ordered: 0,
    has_negative_received: 0,
    has_invalid_order_item_deletion_flag: 0,
    is_active_duplicate: 0,
    has_mismatched_ledger_item: 0,
    has_receipt_ledger_mismatch: 0,
    has_status_mismatch: 0,
    has_missing_order_parent: 0,
    has_deleted_order_parent: 0,
    has_invalid_order_parent_deletion_flag: 0,
    has_missing_item_parent: 0,
    has_deleted_item_parent: 0,
    has_invalid_item_parent_deletion_flag: 0,
    is_masked_remaining_item: 0,
    ...overrides,
  };
}

test('local Wrangler child environment는 production Cloudflare credential을 제거한다', () => {
  const source = {
    PATH: '/usr/bin',
    CLOUDFLARE_API_TOKEN: 'production-token',
    CLOUDFLARE_ACCOUNT_ID: 'production-account',
    CLOUDFLARE_API_KEY: 'production-api-key',
    CLOUDFLARE_EMAIL: 'production@example.com',
  };

  assert.deepEqual(buildLocalWranglerEnvironment(source), { PATH: '/usr/bin' });
  assert.equal(source.CLOUDFLARE_API_TOKEN, 'production-token');
  assert.equal(source.CLOUDFLARE_ACCOUNT_ID, 'production-account');
  assert.equal(source.CLOUDFLARE_API_KEY, 'production-api-key');
  assert.equal(source.CLOUDFLARE_EMAIL, 'production@example.com');
});

function buildLocalWranglerEnvironment(source) {
  const environment = { ...source };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_ACCOUNT_ID;
  delete environment.CLOUDFLARE_API_KEY;
  delete environment.CLOUDFLARE_EMAIL;
  return environment;
}

function runAuditCli(args) {
  return spawnSync(process.execPath, [AUDIT_SCRIPT_PATH, ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: buildLocalWranglerEnvironment(process.env),
    maxBuffer: 16 * 1024 * 1024,
  });
}

function createD1Scenario(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const persistTo = path.join(root, 'd1');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, persistTo };
}

function runWrangler(args) {
  assert.ok(args.includes('--local'), '통합 테스트는 local D1만 사용해야 합니다.');
  assert.ok(!args.includes('--remote'), '통합 테스트에서 remote D1을 사용할 수 없습니다.');
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: buildLocalWranglerEnvironment(process.env),
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function executeSqlFile(persistTo, sqlPath) {
  runWrangler([
    'd1', 'execute', 'hereisorder', '--local', '--persist-to', persistTo,
    `--file=${sqlPath}`,
  ]);
}

function executeTemporarySql({ root, persistTo }, name, sql) {
  const sqlPath = path.join(root, name);
  fs.writeFileSync(sqlPath, sql);
  executeSqlFile(persistTo, sqlPath);
}

function runAuditSummary(persistTo) {
  const result = runWrangler([
    'd1', 'execute', 'hereisorder', '--local', '--persist-to', persistTo,
    '--json', `--file=${SUMMARY_SQL_PATH}`,
  ]);
  return parseWranglerAuditResult(result.stdout);
}

function runAuditDetails(persistTo) {
  const result = runWrangler([
    'd1', 'execute', 'hereisorder', '--local', '--persist-to', persistTo,
    '--json', `--file=${DETAILS_SQL_PATH}`,
  ]);
  return auditModule.parseWranglerDetailRows(result.stdout);
}

function queryRows(persistTo, sql) {
  const result = runWrangler([
    'd1', 'execute', 'hereisorder', '--local', '--persist-to', persistTo,
    '--json', `--command=${sql}`,
  ]);
  const batches = JSON.parse(result.stdout);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].success, true);
  return batches[0].results;
}

test('details schema와 parser는 독립적인 exact 27-field 계약만 허용한다', () => {
  assert.deepEqual(auditModule.DETAIL_FIELDS, EXPECTED_DETAIL_FIELDS);
  const row = validDetailRow({
    order_is_deleted: null,
    item_is_deleted: null,
    stored_status: null,
  });
  const parsed = auditModule.parseWranglerDetailRows(detailWranglerStdout([row]));
  assert.deepEqual(parsed, [row]);
  assert.deepEqual(Object.keys(parsed[0]), EXPECTED_DETAIL_FIELDS);
  assert.deepEqual(auditModule.parseWranglerDetailRows(detailWranglerStdout([])), []);

  const missing = { ...row };
  delete missing.ledger_in_qty;
  for (const invalid of [
    missing,
    { ...row, password_hash: 'sensitive' },
  ]) {
    assert.throws(
      () => auditModule.parseWranglerDetailRows(detailWranglerStdout([invalid])),
      /details.*field/i,
    );
  }
  assert.throws(
    () => auditModule.parseWranglerDetailRows(detailWranglerStdout([
      { ...row, query_version: 'future-version' },
    ])),
    /version/i,
  );
});

test('details parser는 integer, nullable parent, status, numeric flag를 coercion 없이 검증한다', () => {
  const invalidIntegers = [
    '1', true, false, null, 0.5, Number.MAX_SAFE_INTEGER + 1,
  ];
  for (const field of DETAIL_INTEGER_FIELDS) {
    for (const value of invalidIntegers) {
      assert.throws(
        () => auditModule.parseWranglerDetailRows(detailWranglerStdout([
          validDetailRow({ [field]: value }),
        ])),
        new RegExp(field),
      );
    }
  }
  for (const field of DETAIL_NULLABLE_INTEGER_FIELDS) {
    assert.doesNotThrow(() => auditModule.parseWranglerDetailRows(detailWranglerStdout([
      validDetailRow({ [field]: null }),
    ])));
    for (const value of ['0', true, false, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => auditModule.parseWranglerDetailRows(detailWranglerStdout([
          validDetailRow({ [field]: value }),
        ])),
        new RegExp(field),
      );
    }
  }
  for (const field of DETAIL_FLAG_FIELDS) {
    for (const value of ['0', true, false, null, -1, 2, 0.5]) {
      assert.throws(
        () => auditModule.parseWranglerDetailRows(detailWranglerStdout([
          validDetailRow({ [field]: value }),
        ])),
        new RegExp(field),
      );
    }
  }

  for (const storedStatus of [
    null, 'draft', 'ordered', 'partially_received', 'fully_received', 'canceled',
  ]) {
    assert.doesNotThrow(() => auditModule.parseWranglerDetailRows(detailWranglerStdout([
      validDetailRow({ stored_status: storedStatus }),
    ])));
  }
  for (const derivedStatus of ['ordered', 'partially_received', 'fully_received']) {
    assert.doesNotThrow(() => auditModule.parseWranglerDetailRows(detailWranglerStdout([
      validDetailRow({ derived_status: derivedStatus }),
    ])));
  }
  for (const [field, values] of [
    ['stored_status', ['', 'unknown', 0, false]],
    ['derived_status', [null, '', 'draft', 'canceled', 0, false]],
  ]) {
    for (const value of values) {
      assert.throws(
        () => auditModule.parseWranglerDetailRows(detailWranglerStdout([
          validDetailRow({ [field]: value }),
        ])),
        new RegExp(field),
      );
    }
  }
});

test('executeD1Audit는 fixed path와 bounded captured spawn contract만 사용한다', () => {
  const env = { SAFE_ENV: 'yes' };
  const calls = [];
  const stdout = wranglerStdout(cleanRow);
  const runner = (executable, args, options) => {
    calls.push({ executable, args, options });
    return { status: 0, signal: null, stdout, stderr: '' };
  };

  assert.equal(auditModule.executeD1Audit({
    mode: 'summary',
    target: 'local',
    persistTo: '/tmp/hio-integrity',
    sqlPath: '/tmp/operator-controlled.sql',
    env,
    runner,
  }), stdout);
  assert.equal(auditModule.executeD1Audit({
    mode: 'details',
    target: 'remote',
    env,
    runner,
  }), stdout);

  const expectedOptions = {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  };
  assert.deepEqual(calls, [
    {
      executable: process.execPath,
      args: [
        WRANGLER_BIN,
        'd1', 'execute', 'hereisorder', '--local', '--json',
        `--config=${WRANGLER_CONFIG_PATH}`,
        `--file=${SUMMARY_SQL_PATH}`,
        '--persist-to', '/tmp/hio-integrity',
      ],
      options: expectedOptions,
    },
    {
      executable: process.execPath,
      args: [
        WRANGLER_BIN,
        'd1', 'execute', 'hereisorder', '--remote', '--json',
        `--config=${WRANGLER_CONFIG_PATH}`,
        `--file=${DETAILS_SQL_PATH}`,
      ],
      options: expectedOptions,
    },
  ]);
});

test('executeD1Audit는 mode, target, remote persistence를 runner 전에 fail closed 한다', () => {
  let calls = 0;
  const runner = () => {
    calls += 1;
    return { status: 0, stdout: '[]', stderr: '' };
  };
  for (const options of [
    { mode: 'arbitrary', target: 'local' },
    { mode: 'summary', target: 'staging' },
    { mode: 'details', target: 'remote', persistTo: '/tmp/not-allowed' },
  ]) {
    assert.throws(
      () => auditModule.executeD1Audit({ ...options, runner }),
      /audit (mode|target)|persist/i,
    );
  }
  assert.equal(calls, 0);
});

test('executeD1Audit failure는 runner detail과 raw output을 절대 노출하지 않는다', () => {
  const runners = [
    () => { throw new Error('runner-throw-secret'); },
    () => ({
      error: new Error('runner-error-secret'),
      status: null,
      signal: null,
      stdout: 'error-stdout-secret',
      stderr: 'error-stderr-secret',
    }),
    () => ({
      status: 9,
      signal: null,
      stdout: 'status-stdout-secret',
      stderr: 'status-stderr-secret',
    }),
    () => ({
      status: null,
      signal: 'SIGTERM',
      stdout: 'signal-stdout-secret',
      stderr: 'signal-stderr-secret',
    }),
  ];
  for (const runner of runners) {
    assert.throws(
      () => auditModule.executeD1Audit({ mode: 'summary', target: 'local', runner }),
      (error) => {
        const message = String(error);
        for (const secret of [
          'runner-throw-secret', 'runner-error-secret',
          'error-stdout-secret', 'error-stderr-secret',
          'status-stdout-secret', 'status-stderr-secret',
          'SIGTERM', 'signal-stdout-secret', 'signal-stderr-secret',
        ]) {
          assert.equal(message.includes(secret), false, secret);
        }
        return /D1 audit execution failed/.test(message);
      },
    );
  }
});

test('summary orchestration은 whitelisted JSON 하나만 log하고 raw failure를 숨긴다', async () => {
  const logs = [];
  const report = await auditModule.runOrderItemIntegrityAudit({
    args: ['--local', '--summary', '--persist-to', '/tmp/hio-audit'],
    env: {},
    now: () => new Date(EXECUTED_AT),
    log: (value) => logs.push(value),
    runner: () => ({
      status: 0,
      signal: null,
      stdout: wranglerStdout(cleanRow),
      stderr: 'raw-sensitive-stderr',
    }),
  });
  const expected = evaluateAuditSummary(cleanRow, EXECUTED_AT);
  assert.deepEqual(report, expected);
  assert.deepEqual(logs, [JSON.stringify(expected)]);
  assert.equal(logs[0].includes('raw-sensitive-stderr'), false);

  for (const runner of [
    () => ({
      status: 1,
      signal: null,
      stdout: 'secret-row',
      stderr: 'secret-error',
    }),
    () => ({
      status: 0,
      signal: null,
      stdout: 'secret-invalid-json',
      stderr: 'secret-parse-stderr',
    }),
  ]) {
    await assert.rejects(
      auditModule.runOrderItemIntegrityAudit({
        args: ['--local', '--summary'],
        env: {},
        now: () => new Date(EXECUTED_AT),
        log: () => {},
        runner,
      }),
      (error) => {
        const message = String(error);
        for (const secret of [
          'secret-row', 'secret-error', 'secret-invalid-json', 'secret-parse-stderr',
        ]) {
          assert.equal(message.includes(secret), false, secret);
        }
        return true;
      },
    );
  }
});

test('details preflight는 모든 unsafe output을 D1과 파일 생성 전에 거부한다', async (t) => {
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-detail-preflight-'));
  const insideParent = fs.mkdtempSync(path.join(PROJECT_ROOT, '..evil-'));
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(insideParent, { recursive: true, force: true }));

  const existingFile = path.join(externalRoot, 'existing.json');
  fs.writeFileSync(existingFile, 'existing');
  const symlinkTarget = path.join(externalRoot, 'symlink-target.json');
  fs.writeFileSync(symlinkTarget, 'target');
  const finalSymlink = path.join(externalRoot, 'final-symlink.json');
  fs.symlinkSync(symlinkTarget, finalSymlink);
  const repoParentSymlink = path.join(externalRoot, 'repo-parent');
  fs.symlinkSync(PROJECT_ROOT, repoParentSymlink, 'dir');

  let calls = 0;
  const runner = () => {
    calls += 1;
    return { status: 0, signal: null, stdout: detailWranglerStdout([]), stderr: '' };
  };
  const cases = [
    {
      args: ['--remote', '--details', '--output', path.join(externalRoot, 'ci.json')],
      env: { CI: 'true' },
    },
    { args: ['--remote', '--details', '--output', 'relative.json'], env: {} },
    {
      args: ['--remote', '--details', '--output', path.join(insideParent, 'inside.json')],
      env: {},
    },
    {
      args: [
        '--remote', '--details', '--output',
        path.join(externalRoot, 'missing-parent', 'details.json'),
      ],
      env: {},
    },
    { args: ['--remote', '--details', '--output', existingFile], env: {} },
    { args: ['--remote', '--details', '--output', finalSymlink], env: {} },
    {
      args: [
        '--remote', '--details', '--output', path.join(repoParentSymlink, 'details.json'),
      ],
      env: {},
    },
    { args: ['--remote', '--details', '--output', externalRoot], env: {} },
  ];

  for (const options of cases) {
    await assert.rejects(() => auditModule.runOrderItemIntegrityAudit({
      ...options,
      now: () => new Date(EXECUTED_AT),
      log: () => {},
      runner,
    }));
    assert.equal(calls, 0);
  }
  assert.equal(fs.existsSync(path.join(insideParent, 'inside.json')), false);
  assert.equal(fs.existsSync(path.join(externalRoot, 'ci.json')), false);
});

test('details는 mode 0600 inode를 먼저 예약하고 fd로만 기록하며 EEXIST한다', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-detail-success-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'details.json');
  const row = validDetailRow({ order_item_id: 987654321 });
  const logs = [];
  let calls = 0;
  const options = {
    args: ['--local', '--details', '--output', output],
    env: {},
    now: () => new Date(EXECUTED_AT),
    log: (value) => logs.push(value),
    runner: () => {
      calls += 1;
      assert.equal(fs.statSync(output).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(output, 'utf8'), '');
      return {
        status: 0,
        signal: null,
        stdout: detailWranglerStdout([row]),
        stderr: 'raw-detail-stderr',
      };
    },
  };

  assert.deepEqual(await auditModule.runOrderItemIntegrityAudit(options), {
    outcome: 'details_written',
    rowCount: 1,
  });
  assert.equal(calls, 1);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), {
    queryVersion: 'order-item-integrity-v1',
    executedAt: EXECUTED_AT,
    rows: [row],
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].includes('987654321'), false);
  assert.equal(logs[0].includes('raw-detail-stderr'), false);

  await assert.rejects(
    () => auditModule.runOrderItemIntegrityAudit(options),
    /EEXIST/,
  );
  assert.equal(calls, 1);
});

test('details execute/parse failure는 reserved inode만 정리하고 raw data를 숨긴다', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-detail-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    {
      name: 'execute.json',
      runner: () => ({
        status: 1,
        signal: null,
        stdout: 'execute-secret-row',
        stderr: 'execute-secret-error',
      }),
      secrets: ['execute-secret-row', 'execute-secret-error'],
    },
    {
      name: 'parse.json',
      runner: () => ({
        status: 0,
        signal: null,
        stdout: detailWranglerStdout([
          { ...validDetailRow(), session_token: 'parse-secret-token' },
        ]),
        stderr: 'parse-secret-stderr',
      }),
      secrets: ['parse-secret-token', 'parse-secret-stderr'],
    },
  ];

  for (const scenario of cases) {
    const output = path.join(root, scenario.name);
    await assert.rejects(
      () => auditModule.runOrderItemIntegrityAudit({
        args: ['--local', '--details', '--output', output],
        env: {},
        now: () => new Date(EXECUTED_AT),
        log: () => {},
        runner: scenario.runner,
      }),
      (error) => {
        const message = String(error);
        for (const secret of scenario.secrets) {
          assert.equal(message.includes(secret), false, secret);
        }
        return true;
      },
    );
    assert.equal(fs.existsSync(output), false, scenario.name);
  }

  const replacementOutput = path.join(root, 'attacker-replacement.json');
  await assert.rejects(() => auditModule.runOrderItemIntegrityAudit({
    args: ['--local', '--details', '--output', replacementOutput],
    env: {},
    now: () => new Date(EXECUTED_AT),
    log: () => {},
    runner: () => {
      fs.unlinkSync(replacementOutput);
      fs.writeFileSync(replacementOutput, 'attacker replacement');
      return {
        status: 1,
        signal: null,
        stdout: 'replacement-secret-row',
        stderr: 'replacement-secret-error',
      };
    },
  }));
  assert.equal(fs.readFileSync(replacementOutput, 'utf8'), 'attacker replacement');
});

test('target와 mode를 정확히 하나씩 요구한다', () => {
  assert.deepEqual(parseAuditArguments(['--remote', '--summary']), {
    target: 'remote', mode: 'summary', persistTo: null, output: null,
  });
  assert.throws(() => parseAuditArguments(['--summary']), /--remote.*--local/);
  assert.throws(() => parseAuditArguments(['--remote']), /--summary.*--details/);
  assert.throws(() => parseAuditArguments(['--remote', '--summary', '--command', 'DELETE']), /알 수 없는 옵션/);
  assert.throws(() => parseAuditArguments(['--local', '--summary', '--persist-to']), /값이 필요/);
  assert.throws(() => parseAuditArguments(['--remote', '--details', '--output']), /값이 필요/);
  assert.throws(
    () => parseAuditArguments(['--local', '--summary', '--persist-to', '/a', '--persist-to', '/b']),
    /한 번만/,
  );
});

test('CLI unexpected failure는 exit 1이고 audit payload를 stdout에 남기지 않는다', () => {
  const result = runAuditCli([]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});

test('fixed SQL은 read-only single statement만 허용한다', () => {
  assert.doesNotThrow(() => assertReadOnlyAuditSql("WITH rows AS (SELECT 'DELETE' AS word) SELECT * FROM rows;"));
  assert.doesNotThrow(() => assertReadOnlyAuditSql(SUMMARY_SQL));
  for (const field of COUNT_FIELDS) {
    const aliases = SUMMARY_SQL.match(new RegExp(`\\bAS\\s+${field}\\b`, 'gi')) ?? [];
    assert.equal(aliases.length, 1, `${field} alias가 정확히 한 번 필요합니다.`);
  }
  for (const sql of [
    'SELECT 1; DELETE FROM users;',
    'PRAGMA foreign_keys = OFF;',
    'WITH rows AS (SELECT 1) UPDATE users SET name = name;',
  ]) {
    assert.throws(() => assertReadOnlyAuditSql(sql), /read-only/);
  }
});

test('details SQL은 fixed read-only safe-field query이고 deterministic order를 가진다', () => {
  const sql = fs.readFileSync(DETAILS_SQL_PATH, 'utf8');
  assert.doesNotThrow(() => assertReadOnlyAuditSql(sql));
  assert.match(sql, /ORDER BY\s+order_item_id\s+ASC/i);
  for (const forbidden of [
    'name', 'title', 'memo', 'password_hash', 'session_token',
    'creation_token', 'operation_token', 'before_json', 'after_json',
  ]) {
    assert.doesNotMatch(sql, new RegExp(`\\b${forbidden}\\b`, 'i'));
  }
});

test('Wrangler JSON에서 정확히 한 summary row만 받는다', () => {
  assert.deepEqual(parseWranglerAuditResult(wranglerStdout(cleanRow)), cleanRow);
  assert.throws(() => parseWranglerAuditResult('not-json'), /Wrangler JSON/);
  assert.throws(
    () => parseWranglerAuditResult(JSON.stringify([{ success: true, results: [] }])),
    /summary row/,
  );
});

test('summary row는 정확한 field whitelist만 허용한다', () => {
  assert.deepEqual(Object.keys(cleanRow).sort(), SUMMARY_FIELDS);
  const missing = { ...cleanRow };
  delete missing.masked_orders;
  const invalidRows = [
    missing,
    { ...cleanRow, unexpected_count: 0 },
  ];

  for (const row of invalidRows) {
    assert.throws(() => parseWranglerAuditResult(wranglerStdout(row)), /summary field/);
    assert.throws(() => evaluateAuditSummary(row, EXECUTED_AT), /summary field/);
  }
});

test('모든 aggregate count는 coercion 없는 nonnegative safe integer number여야 한다', () => {
  const invalidCounts = [
    '0',
    false,
    true,
    null,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ];

  for (const field of COUNT_FIELDS) {
    for (const value of invalidCounts) {
      const row = { ...cleanRow, [field]: value };
      const expected = new RegExp(`invalid audit count: ${field}`);
      assert.throws(() => parseWranglerAuditResult(wranglerStdout(row)), expected);
      assert.throws(() => evaluateAuditSummary(row, EXECUTED_AT), expected);
    }
  }
});

test('deleted legacy rows만 있으면 clean이고 active defect는 repair_required다', () => {
  const clean = evaluateAuditSummary(cleanRow, EXECUTED_AT);
  assert.equal(clean.outcome, 'clean');
  const repair = evaluateAuditSummary({ ...cleanRow, masked_orders: 1 }, EXECUTED_AT);
  assert.equal(repair.outcome, 'repair_required');
});

test('모든 active integrity count는 각각 repair_required이고 report에 포함된다', () => {
  assert.deepEqual(
    ACTIVE_REPORT_FIELDS.map(([countField]) => countField).sort(),
    COUNT_FIELDS.filter((field) => field !== 'deleted_overreceived_rows').sort(),
  );

  for (const [countField, reportField] of ACTIVE_REPORT_FIELDS) {
    const row = { ...cleanRow, [countField]: 1 };
    for (const [activeField] of ACTIVE_REPORT_FIELDS) {
      assert.equal(row[activeField], activeField === countField ? 1 : 0);
    }
    const report = evaluateAuditSummary(row, EXECUTED_AT);
    assert.equal(report.outcome, 'repair_required', countField);
    assert.equal(report[reportField], 1, reportField);
  }
});

test('legacy fixture는 002 migration 전후의 전체 integrity 요약과 duplicate 수선을 고정한다', (t) => {
  const scenario = createD1Scenario(t, 'hio-order-item-integrity-legacy-');
  executeSqlFile(scenario.persistTo, INITIAL_MIGRATION_PATH);
  executeSqlFile(scenario.persistTo, LEGACY_FIXTURE_PATH);

  const beforeMigration = runAuditSummary(scenario.persistTo);
  assert.equal(beforeMigration.active_duplicate_groups, 1);

  executeSqlFile(scenario.persistTo, INTEGRITY_MIGRATION_PATH);

  const summary = runAuditSummary(scenario.persistTo);
  assert.deepEqual(summary, {
    query_version: 'order-item-integrity-v1',
    active_overreceived_rows: 1,
    deleted_overreceived_rows: 1,
    active_overreceived_excess_qty: 2,
    overreceived_orders: 1,
    masked_orders: 1,
    invalid_order_item_deletion_flag_rows: 1,
    active_nonpositive_ordered_rows: 1,
    active_negative_received_rows: 1,
    active_duplicate_groups: 0,
    active_mismatched_ledger_item_rows: 1,
    active_receipt_ledger_mismatch_rows: 1,
    active_status_mismatch_orders: 2,
    active_missing_order_parent_rows: 0,
    active_deleted_order_parent_rows: 1,
    active_invalid_order_parent_deletion_flag_rows: 1,
    active_missing_item_parent_rows: 0,
    active_deleted_item_parent_rows: 1,
    active_invalid_item_parent_deletion_flag_rows: 1,
  });
  assert.equal(evaluateAuditSummary(summary, EXECUTED_AT).outcome, 'repair_required');
  assert.deepEqual(
    queryRows(
      scenario.persistTo,
      `SELECT id, ordered_qty, received_qty, is_deleted,
              deleted_at IS NOT NULL AS has_deleted_at
         FROM order_items
        WHERE id IN (1006, 1007)
        ORDER BY id`,
    ),
    [
      {
        id: 1006,
        ordered_qty: 5,
        received_qty: 0,
        is_deleted: 0,
        has_deleted_at: 0,
      },
      {
        id: 1007,
        ordered_qty: 3,
        received_qty: 0,
        is_deleted: 1,
        has_deleted_at: 1,
      },
    ],
  );

  const cli = runAuditCli([
    '--local', '--summary', '--persist-to', scenario.persistTo,
  ]);
  assert.equal(cli.error, undefined);
  assert.equal(cli.status, 2);
  assert.equal(cli.stderr, '');
  const lines = cli.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).outcome, 'repair_required');
});

test('FK 없는 shadow schema는 missing order/item parent를 각각 분리해 보고한다', (t) => {
  const scenario = createD1Scenario(t, 'hio-order-item-integrity-missing-');
  executeTemporarySql(scenario, 'missing-parents.sql', `${SHADOW_SCHEMA_SQL}
INSERT INTO items (id, is_deleted) VALUES (1, 0);
INSERT INTO purchase_orders (id, status, is_deleted) VALUES (1, 'ordered', 0);
INSERT INTO order_items
  (id, order_id, item_id, ordered_qty, received_qty, is_deleted)
VALUES
  (1, 999, 1, 1, 0, 0),
  (2, 1, 999, 1, 0, 0);
`);

  const summary = runAuditSummary(scenario.persistTo);
  assert.deepEqual(summary, {
    query_version: 'order-item-integrity-v1',
    active_overreceived_rows: 0,
    deleted_overreceived_rows: 0,
    active_overreceived_excess_qty: 0,
    overreceived_orders: 0,
    masked_orders: 0,
    invalid_order_item_deletion_flag_rows: 0,
    active_nonpositive_ordered_rows: 0,
    active_negative_received_rows: 0,
    active_duplicate_groups: 0,
    active_mismatched_ledger_item_rows: 0,
    active_receipt_ledger_mismatch_rows: 0,
    active_status_mismatch_orders: 0,
    active_missing_order_parent_rows: 1,
    active_deleted_order_parent_rows: 0,
    active_invalid_order_parent_deletion_flag_rows: 0,
    active_missing_item_parent_rows: 1,
    active_deleted_item_parent_rows: 0,
    active_invalid_item_parent_deletion_flag_rows: 0,
  });
  assert.equal(evaluateAuditSummary(summary, EXECUTED_AT).outcome, 'repair_required');
});

test('deleted over-receipt만 있는 DB는 repair-required count가 모두 0이다', (t) => {
  const scenario = createD1Scenario(t, 'hio-order-item-integrity-deleted-');
  executeTemporarySql(scenario, 'deleted-only.sql', `${SHADOW_SCHEMA_SQL}
INSERT INTO items (id, is_deleted) VALUES (1, 0);
INSERT INTO purchase_orders (id, status, is_deleted) VALUES (1, 'ordered', 0);
INSERT INTO order_items
  (id, order_id, item_id, ordered_qty, received_qty, is_deleted)
VALUES (1, 1, 1, 1, 2, 1);
`);

  const summary = runAuditSummary(scenario.persistTo);
  assert.deepEqual(summary, {
    query_version: 'order-item-integrity-v1',
    active_overreceived_rows: 0,
    deleted_overreceived_rows: 1,
    active_overreceived_excess_qty: 0,
    overreceived_orders: 0,
    masked_orders: 0,
    invalid_order_item_deletion_flag_rows: 0,
    active_nonpositive_ordered_rows: 0,
    active_negative_received_rows: 0,
    active_duplicate_groups: 0,
    active_mismatched_ledger_item_rows: 0,
    active_receipt_ledger_mismatch_rows: 0,
    active_status_mismatch_orders: 0,
    active_missing_order_parent_rows: 0,
    active_deleted_order_parent_rows: 0,
    active_invalid_order_parent_deletion_flag_rows: 0,
    active_missing_item_parent_rows: 0,
    active_deleted_item_parent_rows: 0,
    active_invalid_item_parent_deletion_flag_rows: 0,
  });
  assert.equal(evaluateAuditSummary(summary, EXECUTED_AT).outcome, 'clean');
});

test('전체 migration을 적용한 빈 healthy DB는 모든 integrity count가 0이다', (t) => {
  const scenario = createD1Scenario(t, 'hio-order-item-integrity-healthy-');
  executeSqlFile(scenario.persistTo, INITIAL_MIGRATION_PATH);
  executeSqlFile(scenario.persistTo, INTEGRITY_MIGRATION_PATH);

  const summary = runAuditSummary(scenario.persistTo);
  assert.deepEqual(summary, {
    query_version: 'order-item-integrity-v1',
    active_overreceived_rows: 0,
    deleted_overreceived_rows: 0,
    active_overreceived_excess_qty: 0,
    overreceived_orders: 0,
    masked_orders: 0,
    invalid_order_item_deletion_flag_rows: 0,
    active_nonpositive_ordered_rows: 0,
    active_negative_received_rows: 0,
    active_duplicate_groups: 0,
    active_mismatched_ledger_item_rows: 0,
    active_receipt_ledger_mismatch_rows: 0,
    active_status_mismatch_orders: 0,
    active_missing_order_parent_rows: 0,
    active_deleted_order_parent_rows: 0,
    active_invalid_order_parent_deletion_flag_rows: 0,
    active_missing_item_parent_rows: 0,
    active_deleted_item_parent_rows: 0,
    active_invalid_item_parent_deletion_flag_rows: 0,
  });
  assert.equal(evaluateAuditSummary(summary, EXECUTED_AT).outcome, 'clean');

  const cli = runAuditCli([
    '--local', '--summary', '--persist-to', scenario.persistTo,
  ]);
  assert.equal(cli.error, undefined);
  assert.equal(cli.status, 0);
  assert.equal(cli.stderr, '');
  const lines = cli.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).outcome, 'clean');
});

test('post-002 comprehensive fixture details는 exact IDs, flags, matching ledger를 반환한다', (t) => {
  const scenario = createD1Scenario(t, 'hio-order-item-details-legacy-');
  executeSqlFile(scenario.persistTo, INITIAL_MIGRATION_PATH);
  executeSqlFile(scenario.persistTo, LEGACY_FIXTURE_PATH);
  executeSqlFile(scenario.persistTo, INTEGRITY_MIGRATION_PATH);

  const rows = runAuditDetails(scenario.persistTo);
  for (const row of rows) assert.deepEqual(Object.keys(row), EXPECTED_DETAIL_FIELDS);
  assert.deepEqual(rows.map((row) => row.order_item_id), [
    1001, 1002, 1003, 1004, 1005, 1008, 1009,
    1010, 1011, 1012, 1013, 1014, 1015,
  ]);
  assert.deepEqual(rows.map((row) => ({
    id: row.order_item_id,
    ledgerInQty: row.ledger_in_qty,
    flags: DETAIL_FLAG_FIELDS.filter((field) => row[field] === 1),
  })), [
    { id: 1001, ledgerInQty: 3, flags: ['is_over_received', 'has_status_mismatch'] },
    {
      id: 1002,
      ledgerInQty: 1,
      flags: ['has_status_mismatch', 'is_masked_remaining_item'],
    },
    {
      id: 1003,
      ledgerInQty: 2,
      flags: ['is_over_received', 'has_status_mismatch'],
    },
    { id: 1004, ledgerInQty: 0, flags: ['has_nonpositive_ordered'] },
    { id: 1005, ledgerInQty: -1, flags: ['has_negative_received'] },
    { id: 1008, ledgerInQty: 0, flags: ['has_deleted_order_parent'] },
    {
      id: 1009,
      ledgerInQty: 0,
      flags: ['has_invalid_order_parent_deletion_flag'],
    },
    { id: 1010, ledgerInQty: 0, flags: ['has_deleted_item_parent'] },
    {
      id: 1011,
      ledgerInQty: 0,
      flags: ['has_invalid_item_parent_deletion_flag'],
    },
    {
      id: 1012,
      ledgerInQty: 2,
      flags: ['is_over_received', 'has_invalid_order_item_deletion_flag'],
    },
    { id: 1013, ledgerInQty: 1, flags: ['has_mismatched_ledger_item'] },
    { id: 1014, ledgerInQty: 1, flags: ['has_receipt_ledger_mismatch'] },
    { id: 1015, ledgerInQty: 1, flags: ['has_status_mismatch'] },
  ]);

  const byId = new Map(rows.map((row) => [row.order_item_id, row]));
  assert.deepEqual([1001, 1002, 1003, 1015].map((id) => ({
    id,
    stored: byId.get(id).stored_status,
    derived: byId.get(id).derived_status,
  })), [
    { id: 1001, stored: 'fully_received', derived: 'partially_received' },
    { id: 1002, stored: 'fully_received', derived: 'partially_received' },
    { id: 1003, stored: 'fully_received', derived: 'partially_received' },
    { id: 1015, stored: 'fully_received', derived: 'partially_received' },
  ]);
  assert.deepEqual([1008, 1009, 1010, 1011, 1012].map((id) => ({
    id,
    orderItemDeleted: byId.get(id).order_item_is_deleted,
    orderDeleted: byId.get(id).order_is_deleted,
    itemDeleted: byId.get(id).item_is_deleted,
  })), [
    { id: 1008, orderItemDeleted: 0, orderDeleted: 1, itemDeleted: 0 },
    { id: 1009, orderItemDeleted: 0, orderDeleted: 2, itemDeleted: 0 },
    { id: 1010, orderItemDeleted: 0, orderDeleted: 0, itemDeleted: 1 },
    { id: 1011, orderItemDeleted: 0, orderDeleted: 0, itemDeleted: 2 },
    { id: 1012, orderItemDeleted: 2, orderDeleted: 0, itemDeleted: 0 },
  ]);
});

test('FK-free shadow details는 missing parent raw fields를 null로 보존한다', (t) => {
  const scenario = createD1Scenario(t, 'hio-order-item-details-missing-');
  executeTemporarySql(scenario, 'missing-parents.sql', `${SHADOW_SCHEMA_SQL}
INSERT INTO items (id, is_deleted) VALUES (1, 0);
INSERT INTO purchase_orders (id, status, is_deleted) VALUES (1, 'ordered', 0);
INSERT INTO order_items
  (id, order_id, item_id, ordered_qty, received_qty, is_deleted)
VALUES
  (1, 999, 1, 1, 0, 0),
  (2, 1, 999, 1, 0, 0);
`);

  const rows = runAuditDetails(scenario.persistTo);
  assert.deepEqual(rows.map((row) => ({
    orderItemId: row.order_item_id,
    orderDeleted: row.order_is_deleted,
    itemDeleted: row.item_is_deleted,
    storedStatus: row.stored_status,
    derivedStatus: row.derived_status,
    flags: DETAIL_FLAG_FIELDS.filter((field) => row[field] === 1),
  })), [
    {
      orderItemId: 1,
      orderDeleted: null,
      itemDeleted: 0,
      storedStatus: null,
      derivedStatus: 'ordered',
      flags: ['has_missing_order_parent'],
    },
    {
      orderItemId: 2,
      orderDeleted: 0,
      itemDeleted: null,
      storedStatus: 'ordered',
      derivedStatus: 'ordered',
      flags: ['has_missing_item_parent'],
    },
  ]);
});

test('package는 protected order item audit CLI만 노출한다', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    new URL('../package.json', import.meta.url),
    'utf8',
  ));
  assert.equal(
    packageJson.scripts['db:audit:order-items'],
    'node scripts/audit-order-item-integrity.mjs',
  );
});
