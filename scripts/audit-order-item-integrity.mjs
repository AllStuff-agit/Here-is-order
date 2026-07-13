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
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WRANGLER_BIN = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const WRANGLER_CONFIG = fileURLToPath(new URL('../wrangler.toml', import.meta.url));
const SQL_PATHS = Object.freeze({
  summary: fileURLToPath(
    new URL('./sql/audit-order-item-integrity.sql', import.meta.url),
  ),
  details: fileURLToPath(
    new URL('./sql/audit-order-item-integrity-details.sql', import.meta.url),
  ),
});

export const DETAIL_FIELDS = Object.freeze([
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
]);
const SORTED_DETAIL_FIELDS = [...DETAIL_FIELDS].sort();
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
const STORED_STATUSES = new Set([
  'draft',
  'ordered',
  'partially_received',
  'fully_received',
  'canceled',
]);
const DERIVED_STATUSES = new Set([
  'ordered',
  'partially_received',
  'fully_received',
]);

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

function assertExactDetailRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(SORTED_DETAIL_FIELDS)) {
    throw new Error('details result field whitelist가 일치하지 않습니다.');
  }
  if (row.query_version !== AUDIT_QUERY_VERSION) {
    throw new Error('details query version이 일치하지 않습니다.');
  }
  for (const field of DETAIL_INTEGER_FIELDS) {
    if (typeof row[field] !== 'number' || !Number.isSafeInteger(row[field])) {
      throw new Error(`invalid details integer: ${field}`);
    }
  }
  for (const field of DETAIL_NULLABLE_INTEGER_FIELDS) {
    const value = row[field];
    if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
      throw new Error(`invalid details nullable integer: ${field}`);
    }
  }
  for (const field of DETAIL_FLAG_FIELDS) {
    if (row[field] !== 0 && row[field] !== 1) {
      throw new Error(`invalid details flag: ${field}`);
    }
  }
  if (row.stored_status !== null && !STORED_STATUSES.has(row.stored_status)) {
    throw new Error('invalid details status: stored_status');
  }
  if (!DERIVED_STATUSES.has(row.derived_status)) {
    throw new Error('invalid details status: derived_status');
  }
}

export function parseWranglerDetailRows(stdout) {
  let batches;
  try {
    batches = JSON.parse(stdout);
  } catch {
    throw new Error('Wrangler details JSON을 해석할 수 없습니다.');
  }
  if (!Array.isArray(batches) || batches.length !== 1 || batches[0]?.success !== true
      || !Array.isArray(batches[0].results)) {
    throw new Error('Wrangler details 결과가 올바르지 않습니다.');
  }
  for (const row of batches[0].results) assertExactDetailRow(row);
  return batches[0].results;
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

export function executeD1Audit({
  mode,
  target,
  persistTo = null,
  env = process.env,
  runner = spawnSync,
}) {
  if (!Object.hasOwn(SQL_PATHS, mode)) throw new Error('invalid audit mode.');
  if (target !== 'local' && target !== 'remote') throw new Error('invalid audit target.');
  if (persistTo !== null
      && (target !== 'local' || typeof persistTo !== 'string' || persistTo.length === 0)) {
    throw new Error('audit persistence is valid only for local target.');
  }

  const sqlPath = SQL_PATHS[mode];
  const sql = fs.readFileSync(sqlPath, 'utf8');
  assertReadOnlyAuditSql(sql);
  const args = [
    WRANGLER_BIN,
    'd1', 'execute', 'hereisorder',
    target === 'remote' ? '--remote' : '--local',
    '--json',
    `--config=${WRANGLER_CONFIG}`,
    target === 'remote' ? `--command=${sql}` : `--file=${sqlPath}`,
  ];
  if (persistTo !== null) args.push('--persist-to', persistTo);

  let result;
  try {
    result = runner(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error('D1 audit execution failed.');
  }
  if (!result || result.error || result.status !== 0 || result.signal != null
      || typeof result.stdout !== 'string') {
    throw new Error('D1 audit execution failed.');
  }
  return result.stdout;
}

function isWithinPath(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || (!path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`));
}

function outputExistsError() {
  const error = new Error('EEXIST: details output already exists.');
  error.code = 'EEXIST';
  return error;
}

function resolveCanonicalDetailOutput(output, env) {
  if (env.CI === 'true') throw new Error('details audit는 CI에서 실행할 수 없습니다.');
  if (typeof output !== 'string' || !path.isAbsolute(output)) {
    throw new Error('details audit에는 절대 --output 경로가 필요합니다.');
  }

  let repository;
  let parent;
  try {
    repository = fs.realpathSync(REPO_ROOT);
    parent = fs.realpathSync(path.dirname(output));
  } catch {
    throw new Error('details output parent directory가 존재해야 합니다.');
  }
  let parentStat;
  try {
    parentStat = fs.statSync(parent);
  } catch {
    throw new Error('details output parent directory를 확인할 수 없습니다.');
  }
  if (!parentStat.isDirectory()) {
    throw new Error('details output parent는 directory여야 합니다.');
  }

  const canonicalOutput = path.join(parent, path.basename(output));
  if (isWithinPath(repository, canonicalOutput)) {
    throw new Error('details output은 저장소 밖에 있어야 합니다.');
  }
  try {
    fs.lstatSync(canonicalOutput);
    throw outputExistsError();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return canonicalOutput;
}

function closeReservation(reservation) {
  if (reservation.fd === null) return;
  try {
    fs.closeSync(reservation.fd);
  } finally {
    reservation.fd = null;
  }
}

function unlinkReservedInode(reservation) {
  let current;
  try {
    current = fs.lstatSync(reservation.output);
  } catch {
    return;
  }
  if (!current.isSymbolicLink()
      && current.dev === reservation.dev
      && current.ino === reservation.ino) {
    try {
      fs.unlinkSync(reservation.output);
    } catch {
      // The protected inode may have been replaced between validation and cleanup.
    }
  }
}

function cleanupReservation(reservation) {
  try {
    closeReservation(reservation);
  } finally {
    unlinkReservedInode(reservation);
  }
}

function reserveDetailOutput(output, env) {
  const canonicalOutput = resolveCanonicalDetailOutput(output, env);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number'
    ? fs.constants.O_NOFOLLOW
    : 0;
  const flags = fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | fs.constants.O_WRONLY
    | noFollow;
  let fd;
  try {
    fd = fs.openSync(canonicalOutput, flags, 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw outputExistsError();
    throw new Error('details output을 예약할 수 없습니다.');
  }

  let inode;
  try {
    inode = fs.fstatSync(fd);
  } catch {
    try { fs.closeSync(fd); } catch { /* best-effort close */ }
    throw new Error('details output을 확인할 수 없습니다.');
  }
  const reservation = {
    output: canonicalOutput,
    fd,
    dev: inode.dev,
    ino: inode.ino,
  };
  try {
    fs.fchmodSync(fd, 0o600);
  } catch {
    cleanupReservation(reservation);
    throw new Error('details output 권한을 보호할 수 없습니다.');
  }
  return reservation;
}

function assertReservedInode(reservation) {
  let current;
  try {
    current = fs.lstatSync(reservation.output);
  } catch {
    throw new Error('details output reservation이 변경되었습니다.');
  }
  if (current.isSymbolicLink()
      || current.dev !== reservation.dev
      || current.ino !== reservation.ino) {
    throw new Error('details output reservation이 변경되었습니다.');
  }
}

function writeAll(fd, value) {
  const bytes = Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('details output을 기록할 수 없습니다.');
    offset += written;
  }
}

export async function runOrderItemIntegrityAudit({
  args = process.argv.slice(2),
  env = process.env,
  now = () => new Date(),
  log = console.log,
  runner = spawnSync,
} = {}) {
  const options = parseAuditArguments(args);
  if (options.mode === 'summary') {
    const raw = executeD1Audit({
      mode: options.mode,
      target: options.target,
      persistTo: options.persistTo,
      env,
      runner,
    });
    const report = evaluateAuditSummary(
      parseWranglerAuditResult(raw),
      now().toISOString(),
    );
    log(JSON.stringify(report));
    return report;
  }

  const reservation = reserveDetailOutput(options.output, env);
  let result;
  try {
    const raw = executeD1Audit({
      mode: options.mode,
      target: options.target,
      persistTo: options.persistTo,
      env,
      runner,
    });
    const rows = parseWranglerDetailRows(raw);
    writeAll(reservation.fd, JSON.stringify({
      queryVersion: AUDIT_QUERY_VERSION,
      executedAt: now().toISOString(),
      rows,
    }, null, 2));
    fs.fsyncSync(reservation.fd);
    assertReservedInode(reservation);
    result = { outcome: 'details_written', rowCount: rows.length };
  } catch (error) {
    cleanupReservation(reservation);
    throw error;
  }
  closeReservation(reservation);
  log(`Protected order item audit details written: ${reservation.output}`);
  return result;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runOrderItemIntegrityAudit()
    .then((result) => {
      if (result.outcome === 'repair_required') process.exitCode = 2;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Order Item audit failed.');
      process.exitCode = 1;
    });
}
