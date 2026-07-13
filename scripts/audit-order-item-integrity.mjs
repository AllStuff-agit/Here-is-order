#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUDIT_QUERY_VERSION = 'order-item-integrity-v1';
const ACTIVE_FIELDS = [
  'active_overreceived_rows',
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
const ALL_FIELDS = ['deleted_overreceived_rows', ...ACTIVE_FIELDS];
const SUMMARY_FIELDS = ['query_version', ...ALL_FIELDS].sort();

export function parseAuditArguments(argv) {
  let target = null;
  let mode = null;
  let persistTo = null;
  let output = null;
  const nextValue = (index, option) => {
    const candidate = argv[index + 1];
    if (!candidate || candidate.startsWith('--')) throw new Error(`${option} 값이 필요합니다.`);
    return candidate;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--remote' || value === '--local') {
      if (target) throw new Error('--remote와 --local 중 정확히 하나만 사용해야 합니다.');
      target = value.slice(2);
    } else if (value === '--summary' || value === '--details') {
      if (mode) throw new Error('--summary와 --details 중 정확히 하나만 사용해야 합니다.');
      mode = value.slice(2);
    } else if (value === '--persist-to') {
      if (persistTo) throw new Error('--persist-to는 한 번만 사용할 수 있습니다.');
      persistTo = nextValue(index, value);
      index += 1;
    } else if (value === '--output') {
      if (output) throw new Error('--output은 한 번만 사용할 수 있습니다.');
      output = nextValue(index, value);
      index += 1;
    } else throw new Error(`알 수 없는 옵션입니다: ${value}`);
  }
  if (!target) throw new Error('--remote와 --local 중 하나가 필요합니다.');
  if (!mode) throw new Error('--summary와 --details 중 하나가 필요합니다.');
  if (persistTo && target !== 'local') throw new Error('--persist-to는 --local에서만 사용할 수 있습니다.');
  if (output && mode !== 'details') throw new Error('--output은 --details에서만 사용할 수 있습니다.');
  return { target, mode, persistTo, output };
}

export function assertReadOnlyAuditSql(sql) {
  const scrubbed = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/'(?:''|[^'])*'/g, "''");
  const statements = scrubbed.split(';').map((part) => part.trim()).filter(Boolean);
  const mutation = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|TRIGGER)\b/i;
  if (statements.length !== 1 || !/^\s*(WITH|SELECT)\b/i.test(statements[0]) || mutation.test(statements[0])) {
    throw new Error('audit SQL은 read-only single statement여야 합니다.');
  }
}

function assertExactSummaryRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(SUMMARY_FIELDS)) {
    throw new Error('audit summary field whitelist가 일치하지 않습니다.');
  }
  for (const field of ALL_FIELDS) {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`invalid audit count: ${field}`);
    }
  }
}

export function parseWranglerAuditResult(stdout) {
  let batches;
  try { batches = JSON.parse(stdout); } catch { throw new Error('Wrangler JSON을 해석할 수 없습니다.'); }
  if (!Array.isArray(batches) || batches.length !== 1 || batches[0]?.success !== true
      || !Array.isArray(batches[0].results) || batches[0].results.length !== 1) {
    throw new Error('Wrangler가 정확히 한 summary row를 반환해야 합니다.');
  }
  const row = batches[0].results[0];
  assertExactSummaryRow(row);
  return row;
}

export function evaluateAuditSummary(row, executedAt) {
  assertExactSummaryRow(row);
  if (row.query_version !== AUDIT_QUERY_VERSION) throw new Error('audit query version이 일치하지 않습니다.');
  const counts = {};
  for (const field of ALL_FIELDS) counts[field] = row[field];
  return {
    queryVersion: AUDIT_QUERY_VERSION,
    executedAt,
    outcome: ACTIVE_FIELDS.some((field) => counts[field] > 0) ? 'repair_required' : 'clean',
    activeOverreceivedRows: counts.active_overreceived_rows,
    deletedOverreceivedRows: counts.deleted_overreceived_rows,
    activeOverreceivedExcessQty: counts.active_overreceived_excess_qty,
    overreceivedOrders: counts.overreceived_orders,
    maskedOrders: counts.masked_orders,
    invalidOrderItemDeletionFlagRows: counts.invalid_order_item_deletion_flag_rows,
    activeNonpositiveOrderedRows: counts.active_nonpositive_ordered_rows,
    activeNegativeReceivedRows: counts.active_negative_received_rows,
    activeDuplicateGroups: counts.active_duplicate_groups,
    activeMismatchedLedgerItemRows: counts.active_mismatched_ledger_item_rows,
    activeReceiptLedgerMismatchRows: counts.active_receipt_ledger_mismatch_rows,
    activeStatusMismatchOrders: counts.active_status_mismatch_orders,
    activeMissingOrderParentRows: counts.active_missing_order_parent_rows,
    activeDeletedOrderParentRows: counts.active_deleted_order_parent_rows,
    activeInvalidOrderParentDeletionFlagRows:
      counts.active_invalid_order_parent_deletion_flag_rows,
    activeMissingItemParentRows: counts.active_missing_item_parent_rows,
    activeDeletedItemParentRows: counts.active_deleted_item_parent_rows,
    activeInvalidItemParentDeletionFlagRows:
      counts.active_invalid_item_parent_deletion_flag_rows,
  };
}
