import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

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
