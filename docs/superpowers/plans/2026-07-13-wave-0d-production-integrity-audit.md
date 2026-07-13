# Wave 0D Production Order Item Integrity Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a read-only, manually dispatched production audit that detects legacy over-receipt and related active Order Item integrity defects without exposing row data in CI or mutating production.

**Architecture:** Store fixed, reviewed summary/detail SQL in the repository and execute it through a Node Adapter that accepts no arbitrary SQL. CI runs only the one-row aggregate summary and logs a strict whitelist; operator detail mode is prohibited in CI and writes safe fields to a new mode-0600 file outside the repository. A 001→legacy fixture→002 local Wrangler test proves that the audit detects defects left behind by the migration history.

**Tech Stack:** Node.js 22 built-ins, ECMAScript Modules, Node test runner, Wrangler 4.107, Cloudflare D1, GitHub Actions.

## Global Constraints

- This delivery is read-only for production. Do not change migrations, Worker routes, frontend source, or production rows.
- Do not automatically clamp, delete, recalculate, or repair any production data.
- Run production audit only through a separate `workflow_dispatch`; do not add it to push, pull request, schedule, or the deploy workflow.
- Accept no operator-provided SQL, `--command`, or `--file` value.
- Summary output may contain only query version, execution time, outcome, and aggregate numeric counts.
- Detail output may contain only IDs, quantities, deletion flags, stored/derived status, ledger sum, and integrity flags. It must contain no username, password hash, session token, item name, order title, memo, or audit JSON.
- Detail mode must fail before D1 access when `CI=true`, output is missing, output is relative, or output is inside the repository.
- Detail files use `flag: 'wx'` and mode `0600`; never overwrite.
- Raw Wrangler stdout/stderr must never be logged by the Adapter or workflow.
- Deleted over-received rows alone are informational. Any active defect or masked order requires a separate data repair spec and keeps Wave 0 incomplete without reverting 0A–0C.
- Use Node.js 22-compatible built-ins only; add no dependency.
- Follow RED → GREEN → REFACTOR and commit after each independently reviewable task.

## File Map

- `scripts/sql/audit-order-item-integrity.sql`: one-row aggregate summary.
- `scripts/sql/audit-order-item-integrity-details.sql`: operator-only safe-field details.
- `scripts/fixtures/order-item-integrity-legacy.sql`: deterministic legacy defect fixture.
- `scripts/audit-order-item-integrity.mjs`: argument, SQL safety, Wrangler execution, evaluation, and secure output Adapter.
- `scripts/audit-order-item-integrity.test.mjs`: unit plus local migration-history regression.
- `.github/workflows/audit-order-item-integrity.yml`: manual production summary only.
- `scripts/audit-order-item-integrity-workflow.test.mjs`: static workflow safety contract.

---

### Task 1: Define the aggregate audit query and safe evaluation Interface

**Files:**
- Create: `scripts/sql/audit-order-item-integrity.sql`
- Create: `scripts/audit-order-item-integrity.mjs`
- Create: `scripts/audit-order-item-integrity.test.mjs`

**Interfaces:**
- Produces: `AUDIT_QUERY_VERSION`, `parseAuditArguments`, `assertReadOnlyAuditSql`, `parseWranglerAuditResult`, `evaluateAuditSummary`.
- Consumed by: Tasks 2–4.

- [ ] **Step 1: Write failing argument, SQL-safety, parser, and outcome tests**

Create `scripts/audit-order-item-integrity.test.mjs` with these exact unit cases:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertReadOnlyAuditSql,
  evaluateAuditSummary,
  parseAuditArguments,
  parseWranglerAuditResult,
} from './audit-order-item-integrity.mjs';

const cleanRow = {
  query_version: 'order-item-integrity-v1',
  active_overreceived_rows: 0,
  deleted_overreceived_rows: 2,
  active_overreceived_excess_qty: 0,
  overreceived_orders: 0,
  masked_orders: 0,
  active_nonpositive_ordered_rows: 0,
  active_negative_received_rows: 0,
  active_duplicate_groups: 0,
  active_missing_order_parent_rows: 0,
  active_deleted_order_parent_rows: 0,
  active_missing_item_parent_rows: 0,
  active_deleted_item_parent_rows: 0,
};

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
  for (const sql of [
    'SELECT 1; DELETE FROM users;',
    'PRAGMA foreign_keys = OFF;',
    'WITH rows AS (SELECT 1) UPDATE users SET name = name;',
  ]) {
    assert.throws(() => assertReadOnlyAuditSql(sql), /read-only/);
  }
});

test('Wrangler JSON에서 정확히 한 summary row만 받는다', () => {
  const stdout = JSON.stringify([{ success: true, results: [cleanRow], meta: {} }]);
  assert.deepEqual(parseWranglerAuditResult(stdout), cleanRow);
  assert.throws(() => parseWranglerAuditResult('not-json'), /Wrangler JSON/);
  assert.throws(
    () => parseWranglerAuditResult(JSON.stringify([{ success: true, results: [] }])),
    /summary row/,
  );
});

test('deleted legacy rows만 있으면 clean이고 active defect는 repair_required다', () => {
  const clean = evaluateAuditSummary(cleanRow, '2026-07-13T00:00:00.000Z');
  assert.equal(clean.outcome, 'clean');
  const repair = evaluateAuditSummary({ ...cleanRow, masked_orders: 1 }, '2026-07-13T00:00:00.000Z');
  assert.equal(repair.outcome, 'repair_required');
});
```

- [ ] **Step 2: Run the unit test and verify RED**

Run:

```bash
node --test scripts/audit-order-item-integrity.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Add the one-row summary SQL**

Create `scripts/sql/audit-order-item-integrity.sql`:

```sql
WITH active_order_stats AS (
  SELECT oi.order_id,
         SUM(oi.ordered_qty) AS total_ordered_qty,
         SUM(oi.received_qty) AS total_received_qty,
         SUM(CASE WHEN oi.received_qty < oi.ordered_qty THEN 1 ELSE 0 END)
           AS remaining_item_count
    FROM order_items oi
   WHERE oi.is_deleted = 0
   GROUP BY oi.order_id
),
active_duplicate_groups AS (
  SELECT order_id, item_id
    FROM order_items
   WHERE is_deleted = 0
   GROUP BY order_id, item_id
  HAVING COUNT(*) > 1
)
SELECT 'order-item-integrity-v1' AS query_version,
       (SELECT COUNT(*) FROM order_items
         WHERE is_deleted = 0 AND received_qty > ordered_qty)
         AS active_overreceived_rows,
       (SELECT COUNT(*) FROM order_items
         WHERE is_deleted = 1 AND received_qty > ordered_qty)
         AS deleted_overreceived_rows,
       (SELECT COALESCE(SUM(received_qty - ordered_qty), 0)
          FROM order_items
         WHERE is_deleted = 0 AND received_qty > ordered_qty)
         AS active_overreceived_excess_qty,
       (SELECT COUNT(DISTINCT order_id) FROM order_items
         WHERE is_deleted = 0 AND received_qty > ordered_qty)
         AS overreceived_orders,
       (SELECT COUNT(*)
          FROM active_order_stats stats
          JOIN purchase_orders po ON po.id = stats.order_id AND po.is_deleted = 0
         WHERE stats.total_received_qty >= stats.total_ordered_qty
           AND stats.remaining_item_count > 0)
         AS masked_orders,
       (SELECT COUNT(*) FROM order_items
         WHERE is_deleted = 0 AND ordered_qty <= 0)
         AS active_nonpositive_ordered_rows,
       (SELECT COUNT(*) FROM order_items
         WHERE is_deleted = 0 AND received_qty < 0)
         AS active_negative_received_rows,
       (SELECT COUNT(*) FROM active_duplicate_groups)
         AS active_duplicate_groups,
       (SELECT COUNT(*) FROM order_items oi
          LEFT JOIN purchase_orders po ON po.id = oi.order_id
         WHERE oi.is_deleted = 0 AND po.id IS NULL)
         AS active_missing_order_parent_rows,
       (SELECT COUNT(*) FROM order_items oi
          JOIN purchase_orders po ON po.id = oi.order_id
         WHERE oi.is_deleted = 0 AND po.is_deleted = 1)
         AS active_deleted_order_parent_rows,
       (SELECT COUNT(*) FROM order_items oi
          LEFT JOIN items i ON i.id = oi.item_id
         WHERE oi.is_deleted = 0 AND i.id IS NULL)
         AS active_missing_item_parent_rows,
       (SELECT COUNT(*) FROM order_items oi
          JOIN items i ON i.id = oi.item_id
         WHERE oi.is_deleted = 0 AND i.is_deleted = 1)
         AS active_deleted_item_parent_rows;
```

- [ ] **Step 4: Implement strict argument, SQL, JSON, and whitelist evaluation**

Create `scripts/audit-order-item-integrity.mjs` with these core definitions:

```js
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
  'active_nonpositive_ordered_rows',
  'active_negative_received_rows',
  'active_duplicate_groups',
  'active_missing_order_parent_rows',
  'active_deleted_order_parent_rows',
  'active_missing_item_parent_rows',
  'active_deleted_item_parent_rows',
];
const ALL_FIELDS = ['deleted_overreceived_rows', ...ACTIVE_FIELDS];

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

export function parseWranglerAuditResult(stdout) {
  let batches;
  try { batches = JSON.parse(stdout); } catch { throw new Error('Wrangler JSON을 해석할 수 없습니다.'); }
  if (!Array.isArray(batches) || batches.length !== 1 || batches[0].success !== true
      || !Array.isArray(batches[0].results) || batches[0].results.length !== 1) {
    throw new Error('Wrangler가 정확히 한 summary row를 반환해야 합니다.');
  }
  return batches[0].results[0];
}

export function evaluateAuditSummary(row, executedAt) {
  if (row.query_version !== AUDIT_QUERY_VERSION) throw new Error('audit query version이 일치하지 않습니다.');
  const counts = {};
  for (const field of ALL_FIELDS) {
    const value = Number(row[field]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid audit count: ${field}`);
    counts[field] = value;
  }
  return {
    queryVersion: AUDIT_QUERY_VERSION,
    executedAt,
    outcome: ACTIVE_FIELDS.some((field) => counts[field] > 0) ? 'repair_required' : 'clean',
    activeOverreceivedRows: counts.active_overreceived_rows,
    deletedOverreceivedRows: counts.deleted_overreceived_rows,
    activeOverreceivedExcessQty: counts.active_overreceived_excess_qty,
    overreceivedOrders: counts.overreceived_orders,
    maskedOrders: counts.masked_orders,
    activeNonpositiveOrderedRows: counts.active_nonpositive_ordered_rows,
    activeNegativeReceivedRows: counts.active_negative_received_rows,
    activeDuplicateGroups: counts.active_duplicate_groups,
    activeMissingOrderParentRows: counts.active_missing_order_parent_rows,
    activeDeletedOrderParentRows: counts.active_deleted_order_parent_rows,
    activeMissingItemParentRows: counts.active_missing_item_parent_rows,
    activeDeletedItemParentRows: counts.active_deleted_item_parent_rows,
  };
}
```

- [ ] **Step 5: Run unit tests and verify GREEN**

Run:

```bash
node --test scripts/audit-order-item-integrity.test.mjs
```

Expected: all unit cases pass.

- [ ] **Step 6: Commit the summary Interface**

```bash
git add scripts/sql/audit-order-item-integrity.sql \
  scripts/audit-order-item-integrity.mjs scripts/audit-order-item-integrity.test.mjs
git commit -m "feat: define order item integrity audit"
```

---

### Task 2: Prove the query against 001→legacy→002 migration history

**Files:**
- Create: `scripts/fixtures/order-item-integrity-legacy.sql`
- Modify: `scripts/audit-order-item-integrity.test.mjs`

**Interfaces:**
- Consumes: Task 1 fixed summary SQL.
- Produces: regression evidence that migration 002 does not repair legacy over-receipt or aggregate masking.

- [ ] **Step 1: Add the deterministic legacy fixture**

Create `scripts/fixtures/order-item-integrity-legacy.sql`:

```sql
INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
VALUES ('legacy overreceived', '개', 0, 0, 0, 0),
       ('legacy remaining', '개', 0, 0, 0, 0),
       ('legacy deleted overreceived', '개', 0, 0, 0, 0);

INSERT INTO purchase_orders (title, status)
VALUES ('legacy masked order', 'fully_received');

INSERT INTO order_items
  (order_id, item_id, ordered_qty, received_qty, is_deleted, deleted_at)
VALUES
  (1, 1, 1, 3, 0, NULL),
  (1, 2, 3, 1, 0, NULL),
  (1, 3, 1, 2, 1, datetime('now'));
```

- [ ] **Step 2: Add a local Wrangler migration-history test**

In the Node test, create a temporary persistence directory and invoke the checked-in Wrangler binary with `process.execPath`. Execute in this exact order:

```js
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRANGLER_BIN = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);

function runWrangler(args) {
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('001 뒤의 legacy 결함을 002 적용 후에도 검출한다', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-integrity-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const persistTo = path.join(root, 'legacy');

  runWrangler(['d1', 'execute', 'hereisorder', '--local', '--persist-to', persistTo, '--file=migrations/001_init.sql']);
  runWrangler(['d1', 'execute', 'hereisorder', '--local', '--persist-to', persistTo, '--file=scripts/fixtures/order-item-integrity-legacy.sql']);
  runWrangler(['d1', 'execute', 'hereisorder', '--local', '--persist-to', persistTo, '--file=migrations/002_integrity_and_roles.sql']);
  const result = runWrangler([
    'd1', 'execute', 'hereisorder', '--local', '--persist-to', persistTo,
    '--json', '--file=scripts/sql/audit-order-item-integrity.sql',
  ]);
  const summary = parseWranglerAuditResult(result.stdout);
  assert.deepEqual(summary, {
    ...summary,
    query_version: 'order-item-integrity-v1',
    active_overreceived_rows: 1,
    deleted_overreceived_rows: 1,
    active_overreceived_excess_qty: 2,
    overreceived_orders: 1,
    masked_orders: 1,
    active_nonpositive_ordered_rows: 0,
    active_negative_received_rows: 0,
    active_duplicate_groups: 0,
    active_missing_order_parent_rows: 0,
    active_deleted_order_parent_rows: 0,
    active_missing_item_parent_rows: 0,
    active_deleted_item_parent_rows: 0,
  });
  assert.equal(evaluateAuditSummary(summary, '2026-07-13T00:00:00.000Z').outcome, 'repair_required');
});

test('정상 migration DB는 clean이다', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-integrity-clean-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const persistTo = path.join(root, 'clean');
  runWrangler(['d1', 'execute', 'hereisorder', '--local', '--persist-to', persistTo, '--file=migrations/001_init.sql']);
  runWrangler(['d1', 'execute', 'hereisorder', '--local', '--persist-to', persistTo, '--file=migrations/002_integrity_and_roles.sql']);
  const result = runWrangler([
    'd1', 'execute', 'hereisorder', '--local', '--persist-to', persistTo,
    '--json', '--file=scripts/sql/audit-order-item-integrity.sql',
  ]);
  const summary = parseWranglerAuditResult(result.stdout);
  assert.equal(evaluateAuditSummary(summary, '2026-07-13T00:00:00.000Z').outcome, 'clean');
});
```

- [ ] **Step 3: Run the migration-history test**

Run:

```bash
node --test scripts/audit-order-item-integrity.test.mjs
```

Expected: all unit and local Wrangler regression tests pass; no production credentials are used.

- [ ] **Step 4: Commit the legacy fixture proof**

```bash
git add scripts/fixtures/order-item-integrity-legacy.sql \
  scripts/audit-order-item-integrity.test.mjs
git commit -m "test: detect legacy order item corruption"
```

---

### Task 3: Add protected summary execution and operator-only details

**Files:**
- Create: `scripts/sql/audit-order-item-integrity-details.sql`
- Modify: `scripts/audit-order-item-integrity.mjs`
- Modify: `scripts/audit-order-item-integrity.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: fixed SQL and evaluation from Tasks 1–2.
- Produces: `executeD1Audit` and `runOrderItemIntegrityAudit` CLI behavior.

- [ ] **Step 1: Write failing execution and detail-protection tests**

Add these concrete tests with an injected runner and temporary external output:

```js
const cleanStdout = JSON.stringify([{ success: true, results: [cleanRow], meta: {} }]);

test('summary는 whitelist report만 log한다', async () => {
  const logs = [];
  const result = await runOrderItemIntegrityAudit({
    args: ['--local', '--summary', '--persist-to', '/tmp/hio-audit'],
    env: {},
    now: () => new Date('2026-07-13T00:00:00.000Z'),
    log: (value) => logs.push(value),
    runner: () => ({ status: 0, stdout: cleanStdout, stderr: 'raw-sensitive-stderr' }),
  });
  assert.equal(result.outcome, 'clean');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].includes('raw-sensitive-stderr'), false);
  assert.equal(JSON.parse(logs[0]).queryVersion, 'order-item-integrity-v1');
});

test('Wrangler 실패는 raw output을 노출하지 않는다', async () => {
  await assert.rejects(
    runOrderItemIntegrityAudit({
      args: ['--local', '--summary'], env: {}, now: () => new Date(), log: () => {},
      runner: () => ({ status: 1, stdout: 'secret-row', stderr: 'secret-error' }),
    }),
    (error) => !String(error).includes('secret-row') && !String(error).includes('secret-error'),
  );
});

test('details는 CI와 안전하지 않은 output을 D1 실행 전에 거부한다', async () => {
  let calls = 0;
  const runner = () => { calls += 1; return { status: 0, stdout: '[]', stderr: '' }; };
  await assert.rejects(
    runOrderItemIntegrityAudit({
      args: ['--remote', '--details', '--output', '/tmp/details.json'],
      env: { CI: 'true' }, now: () => new Date(), log: () => {}, runner,
    }),
    /CI/,
  );
  await assert.rejects(
    runOrderItemIntegrityAudit({
      args: ['--remote', '--details', '--output', 'relative.json'],
      env: {}, now: () => new Date(), log: () => {}, runner,
    }),
    /절대/,
  );
  await assert.rejects(
    runOrderItemIntegrityAudit({
      args: ['--remote', '--details', '--output', path.join(process.cwd(), 'details.json')],
      env: {}, now: () => new Date(), log: () => {}, runner,
    }),
    /저장소 밖/,
  );
  assert.equal(calls, 0);
});
```

Add this success detail test; export `DETAIL_FIELDS` from the implementation for the static row-shape contract:

```js
test('details는 safe fields만 mode 0600 외부 파일에 한 번 기록한다', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-audit-details-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'details.json');
  const detailRow = Object.fromEntries(DETAIL_FIELDS.map((field) => [field, 0]));
  Object.assign(detailRow, {
    query_version: 'order-item-integrity-v1',
    order_item_id: 987654321,
    stored_status: 'fully_received',
    derived_status: 'partially_received',
  });
  const stdout = JSON.stringify([{ success: true, results: [detailRow], meta: {} }]);
  const logs = [];
  const options = {
    args: ['--local', '--details', '--output', output],
    env: {},
    now: () => new Date('2026-07-13T00:00:00.000Z'),
    log: (value) => logs.push(value),
    runner: () => ({ status: 0, stdout, stderr: '' }),
  };
  await runOrderItemIntegrityAudit(options);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(logs.join('\n').includes('987654321'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')).rows, [detailRow]);
  await assert.rejects(runOrderItemIntegrityAudit(options), /EEXIST/);
});
```

- [ ] **Step 2: Add safe-field details SQL**

Create `scripts/sql/audit-order-item-integrity-details.sql`. Its final projection must be exactly these columns:

```sql
SELECT 'order-item-integrity-v1' AS query_version,
       oi.order_id,
       oi.id AS order_item_id,
       oi.item_id,
       oi.ordered_qty,
       oi.received_qty,
       COALESCE((
         SELECT SUM(CASE WHEN st.movement_type = 'IN' THEN st.quantity ELSE 0 END)
           FROM stock_transactions st
          WHERE st.order_item_id = oi.id
       ), 0) AS ledger_in_qty,
       oi.is_deleted AS order_item_is_deleted,
       po.is_deleted AS order_is_deleted,
       item.is_deleted AS item_is_deleted,
       po.status AS stored_status,
       CASE
         WHEN EXISTS (
           SELECT 1 FROM order_items active
            WHERE active.order_id = oi.order_id AND active.is_deleted = 0
         ) AND NOT EXISTS (
           SELECT 1 FROM order_items active
            WHERE active.order_id = oi.order_id AND active.is_deleted = 0
              AND active.received_qty < active.ordered_qty
         ) THEN 'fully_received'
         WHEN EXISTS (
           SELECT 1 FROM order_items active
            WHERE active.order_id = oi.order_id AND active.is_deleted = 0
              AND active.received_qty > 0
         ) THEN 'partially_received'
         ELSE 'ordered'
       END AS derived_status,
       oi.received_qty > oi.ordered_qty AS is_over_received,
       oi.ordered_qty <= 0 AS has_nonpositive_ordered,
       oi.received_qty < 0 AS has_negative_received,
       (SELECT COUNT(*) FROM order_items duplicate
         WHERE duplicate.order_id = oi.order_id AND duplicate.item_id = oi.item_id
           AND duplicate.is_deleted = 0) > 1 AS is_active_duplicate,
       po.id IS NULL AS has_missing_order_parent,
       COALESCE(po.is_deleted, 0) = 1 AS has_deleted_order_parent,
       item.id IS NULL AS has_missing_item_parent,
       COALESCE(item.is_deleted, 0) = 1 AS has_deleted_item_parent,
       COALESCE(po.is_deleted, 1) = 0
         AND oi.is_deleted = 0 AND oi.received_qty < oi.ordered_qty
         AND (SELECT SUM(active.received_qty) FROM order_items active
               WHERE active.order_id = oi.order_id AND active.is_deleted = 0)
             >=
             (SELECT SUM(active.ordered_qty) FROM order_items active
               WHERE active.order_id = oi.order_id AND active.is_deleted = 0)
         AS is_masked_remaining_item
  FROM order_items oi
  LEFT JOIN purchase_orders po ON po.id = oi.order_id
  LEFT JOIN items item ON item.id = oi.item_id
 WHERE oi.received_qty > oi.ordered_qty
    OR oi.ordered_qty <= 0
    OR oi.received_qty < 0
    OR po.id IS NULL OR po.is_deleted = 1
    OR item.id IS NULL OR item.is_deleted = 1
    OR (SELECT COUNT(*) FROM order_items duplicate
         WHERE duplicate.order_id = oi.order_id AND duplicate.item_id = oi.item_id
           AND duplicate.is_deleted = 0) > 1
    OR (COALESCE(po.is_deleted, 1) = 0
        AND oi.is_deleted = 0 AND oi.received_qty < oi.ordered_qty
        AND (SELECT SUM(active.received_qty) FROM order_items active
              WHERE active.order_id = oi.order_id AND active.is_deleted = 0)
            >=
            (SELECT SUM(active.ordered_qty) FROM order_items active
              WHERE active.order_id = oi.order_id AND active.is_deleted = 0));
```

No name, title, memo, token, credential, or audit JSON column may be added.

- [ ] **Step 3: Implement captured Wrangler execution and protected output**

Use the checked-in Wrangler executable through `spawnSync(process.execPath, [WRANGLER_BIN, ...args], { encoding: 'utf8' })`; never use `stdio: 'inherit'`.

Build only these arguments:

```js
const wranglerArgs = [
  'd1', 'execute', 'hereisorder',
  target === 'remote' ? '--remote' : '--local',
  '--json',
  `--file=${sqlPath}`,
];
if (persistTo) wranglerArgs.push('--persist-to', persistTo);
```

Implement the captured executor with an injectable runner:

```js
const WRANGLER_BIN = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);

export function executeD1Audit({
  sqlPath,
  target,
  persistTo = null,
  env = process.env,
  runner = spawnSync,
}) {
  const sql = fs.readFileSync(sqlPath, 'utf8');
  assertReadOnlyAuditSql(sql);
  const args = [
    WRANGLER_BIN,
    'd1', 'execute', 'hereisorder',
    target === 'remote' ? '--remote' : '--local',
    '--json',
    `--file=${sqlPath}`,
  ];
  if (persistTo) args.push('--persist-to', persistTo);
  const result = runner(process.execPath, args, {
    encoding: 'utf8',
    env,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error('D1 audit process를 시작하지 못했습니다.');
  if (result.status !== 0) throw new Error(`D1 audit가 exit ${result.status}로 실패했습니다.`);
  return String(result.stdout);
}
```

For summary, parse/evaluate and log `JSON.stringify(report)` only. For details, parse the Wrangler envelope and require every row to have only this exact whitelist before writing:

```js
export const DETAIL_FIELDS = [
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
  'is_active_duplicate',
  'has_missing_order_parent',
  'has_deleted_order_parent',
  'has_missing_item_parent',
  'has_deleted_item_parent',
  'is_masked_remaining_item',
].sort();

function parseWranglerDetailRows(stdout) {
  let batches;
  try { batches = JSON.parse(stdout); } catch { throw new Error('Wrangler JSON을 해석할 수 없습니다.'); }
  if (!Array.isArray(batches) || batches.length !== 1 || batches[0].success !== true
      || !Array.isArray(batches[0].results)) {
    throw new Error('Wrangler details 결과가 올바르지 않습니다.');
  }
  for (const row of batches[0].results) {
    if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(DETAIL_FIELDS)) {
      throw new Error('details 결과에 허용되지 않은 field가 있습니다.');
    }
    if (row.query_version !== AUDIT_QUERY_VERSION) throw new Error('details query version이 일치하지 않습니다.');
  }
  return batches[0].results;
}
```

Then protect output as follows:

```js
if (env.CI === 'true') throw new Error('details audit는 CI에서 실행할 수 없습니다.');
if (!output || !path.isAbsolute(output)) throw new Error('details audit에는 절대 --output 경로가 필요합니다.');
const relative = path.relative(process.cwd(), output);
if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
  throw new Error('details output은 저장소 밖에 있어야 합니다.');
}
const rows = parseWranglerDetailRows(rawStdout);
const protectedReport = JSON.stringify({
  queryVersion: AUDIT_QUERY_VERSION,
  executedAt: now().toISOString(),
  rows,
}, null, 2);
fs.writeFileSync(output, protectedReport, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
log(`Protected order item audit details written: ${output}`);
```

Complete the exported orchestration and CLI entrypoint:

```js
export async function runOrderItemIntegrityAudit({
  args = process.argv.slice(2),
  env = process.env,
  now = () => new Date(),
  log = console.log,
  runner = spawnSync,
} = {}) {
  const options = parseAuditArguments(args);
  if (options.mode === 'details') {
    if (env.CI === 'true') throw new Error('details audit는 CI에서 실행할 수 없습니다.');
    if (!options.output || !path.isAbsolute(options.output)) {
      throw new Error('details audit에는 절대 --output 경로가 필요합니다.');
    }
    const relative = path.relative(process.cwd(), options.output);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error('details output은 저장소 밖에 있어야 합니다.');
    }
  }

  const sqlPath = fileURLToPath(new URL(
    options.mode === 'summary'
      ? './sql/audit-order-item-integrity.sql'
      : './sql/audit-order-item-integrity-details.sql',
    import.meta.url,
  ));
  const rawStdout = executeD1Audit({
    sqlPath,
    target: options.target,
    persistTo: options.persistTo,
    env,
    runner,
  });

  if (options.mode === 'summary') {
    const report = evaluateAuditSummary(parseWranglerAuditResult(rawStdout), now().toISOString());
    log(JSON.stringify(report));
    return report;
  }

  const rows = parseWranglerDetailRows(rawStdout);
  fs.writeFileSync(options.output, JSON.stringify({
    queryVersion: AUDIT_QUERY_VERSION,
    executedAt: now().toISOString(),
    rows,
  }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  log(`Protected order item audit details written: ${options.output}`);
  return { outcome: 'details_written', rowCount: rows.length };
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
```

Set CLI `process.exitCode = 2` only when summary outcome is `repair_required`; unexpected failures use 1.

Add to `package.json`:

```json
"db:audit:order-items": "node scripts/audit-order-item-integrity.mjs"
```

- [ ] **Step 4: Run all audit tests and verify GREEN**

Run:

```bash
node --test scripts/audit-order-item-integrity.test.mjs
```

Expected: unit, migration-history, summary, and detail-protection tests all pass.

- [ ] **Step 5: Commit the protected Adapter**

```bash
git add scripts/sql/audit-order-item-integrity-details.sql \
  scripts/audit-order-item-integrity.mjs scripts/audit-order-item-integrity.test.mjs \
  package.json
git commit -m "feat: add protected order item integrity audit"
```

---

### Task 4: Add a manual production-summary workflow with a static safety contract

**Files:**
- Create: `.github/workflows/audit-order-item-integrity.yml`
- Create: `scripts/audit-order-item-integrity-workflow.test.mjs`

**Interfaces:**
- Consumes: `npm run db:audit:order-items -- --remote --summary`.
- Produces: one manual, read-only production audit workflow.

- [ ] **Step 1: Write the failing workflow contract test**

Create `scripts/audit-order-item-integrity-workflow.test.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflowPath = '.github/workflows/audit-order-item-integrity.yml';

test('production integrity audit workflow는 수동 summary만 실행한다', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule):/m);
  assert.match(workflow, /npm run db:audit:order-items -- --remote --summary/);
  for (const forbidden of [
    '--details',
    'upload-artifact',
    'continue-on-error',
    'wrangler d1 execute',
    'GITHUB_OUTPUT',
  ]) {
    assert.equal(workflow.includes(forbidden), false, `${forbidden}를 workflow에 사용할 수 없습니다.`);
  }
});
```

- [ ] **Step 2: Run the static test and verify RED**

Run:

```bash
node --test scripts/audit-order-item-integrity-workflow.test.mjs
```

Expected: FAIL with `ENOENT` for the workflow file.

- [ ] **Step 3: Add the manual workflow**

Create `.github/workflows/audit-order-item-integrity.yml`:

```yaml
name: Audit production order item integrity

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: production-order-item-integrity-audit
  cancel-in-progress: false

jobs:
  audit:
    name: Run read-only production summary
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7.0.0

      - uses: actions/setup-node@v6.4.0
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Audit production Order Item integrity
        run: npm run db:audit:order-items -- --remote --summary
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- [ ] **Step 4: Run the workflow contract and root tests**

Run:

```bash
node --test scripts/audit-order-item-integrity-workflow.test.mjs
npm test
```

Expected: workflow contract and all root tests pass.

- [ ] **Step 5: Commit the workflow**

```bash
git add .github/workflows/audit-order-item-integrity.yml \
  scripts/audit-order-item-integrity-workflow.test.mjs
git commit -m "ci: add production integrity audit"
```

---

### Task 5: Document the audit decision and run the complete verification gate

**Files:**
- Modify: `docs/design/cloudflare-deploy-guide.md`

**Interfaces:**
- Consumes: manual workflow and local protected details command.
- Produces: explicit `clean` versus `repair_required` operator decision.

- [ ] **Step 1: Document the exact operating procedure**

Add a production integrity section containing these commands and decisions:

```bash
# GitHub Actions에서 "Audit production order item integrity"를 수동 실행합니다.

# 상세 증거가 필요할 때만 보호된 운영자 환경에서 실행합니다.
npm run db:audit:order-items -- \
  --remote --details \
  --output /absolute/protected/order-item-integrity.json
```

Document:

- `clean`: active defect counts and masked orders are zero; deleted legacy count is informational.
- `repair_required`: retain deployed 0A–0C hotfixes, do not mutate rows automatically, and create a separate repair spec using ledger/business evidence.
- never upload the detail file to GitHub artifacts or commit it;
- never clamp `received_qty`, delete stock transactions, or rewrite current stock from the summary alone.

- [ ] **Step 2: Run the complete repository verification**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run test --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
npm run build:cloudflare --prefix frontend
git diff --check
```

Expected: all commands pass.

- [ ] **Step 3: Commit the runbook**

```bash
git add docs/design/cloudflare-deploy-guide.md
git commit -m "docs: define production integrity audit response"
```

---

### Task 6: Dispatch the production audit and record the Wave 0 decision

**Files:**
- No repository file changes when the result is `clean`.
- Create a separate data repair spec only when the result is `repair_required`.

**Interfaces:**
- Consumes: the merged main-branch workflow from Task 4 and deployed 0A–0C.
- Produces: a GitHub Actions run URL, query version, execution timestamp, aggregate summary, and the Wave 0 `clean` or `repair_required` decision.

- [ ] **Step 1: Confirm 0A–0C are deployed from main**

Run:

```bash
git fetch origin
git log -1 --oneline origin/main
gh run list --workflow deploy-worker.yml --branch main --limit 3
```

Expected: `origin/main` contains the merged 0A–0C commits and the latest deploy workflow run concludes `success`.

- [ ] **Step 2: Dispatch the audit from main**

Run:

```bash
gh workflow run audit-order-item-integrity.yml --ref main
RUN_ID="$(gh run list --workflow audit-order-item-integrity.yml --branch main --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run view "$RUN_ID" --json databaseId,status,url
```

Expected: `RUN_ID` is non-empty and the displayed run targets `main`. Do not dispatch from a feature branch.

- [ ] **Step 3: Wait for the run and inspect only the summary**

Run:

```bash
RUN_ID="$(gh run list --workflow audit-order-item-integrity.yml --branch main --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --json url,conclusion,headSha,createdAt,updatedAt
gh run view "$RUN_ID" --log
```

Expected clean path: workflow conclusion `success` and the only audit payload is a whitelisted JSON object with `queryVersion: order-item-integrity-v1`, `outcome: clean`, execution time, and aggregate counts.

Expected repair path: workflow conclusion `failure` because the CLI exits 2, and the whitelisted JSON object has `outcome: repair_required`. A failure on this path is an audit finding, not a rollback signal for 0A–0C.

- [ ] **Step 4: Apply the explicit decision**

If `clean`, retain the run URL and aggregate summary in the execution handoff and mark Wave 0 complete.

If `repair_required`, retain the run URL and aggregate summary in the execution handoff, keep 0A–0C deployed, and create `docs/superpowers/specs/2026-07-13-order-item-data-repair-design.md` through a new brainstorming/spec approval cycle. Do not run details in CI and do not mutate production in this plan.

---

## Plan Completion Gate

- The fixed summary SQL is statically read-only and returns one whitelisted aggregate row.
- A 001→invalid fixture→002 local D1 returns `repair_required`; a healthy migrated D1 returns `clean`.
- Deleted legacy rows alone do not fail the summary.
- CI can run summary only and never logs raw Wrangler output or row details.
- Detail mode is impossible in CI and writes only safe fields to a new mode-0600 file outside the repository.
- The production workflow is manual only and contains no mutation, artifact upload, arbitrary SQL, or continue-on-error.
- The merged main workflow has actually run after 0A–0C deployment, and its run URL plus whitelisted production summary are recorded in the handoff.
- Wave 0 is complete only for `clean`; `repair_required` opens a separately approved repair project while leaving security hotfixes deployed.
- No production data is changed by implementation or verification.
- Root, frontend, Cloudflare builds, and `git diff --check` pass.
