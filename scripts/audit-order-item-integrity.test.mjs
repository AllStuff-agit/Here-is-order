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
});
