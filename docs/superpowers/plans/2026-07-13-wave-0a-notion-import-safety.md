# Wave 0A Notion Import Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Notion export conversion deterministic and non-injectable, and require an operator-reviewed SHA-256 before any generated seed is applied to production D1.

**Architecture:** Move SQLite literal encoding and Notion-to-artifact conversion into focused Node Modules, leaving filesystem operations in the CLI Adapter. Treat `import-report.json` as the final commit marker for SQL/CSV artifacts, and route production seed application through an Adapter that verifies the report hash, actual SQL hash, and operator-provided hash before invoking Wrangler.

**Tech Stack:** Node.js 22 built-ins, ECMAScript Modules, Node test runner, Wrangler 4.107, Cloudflare D1/Miniflare.

## Global Constraints

- Preserve current Notion parsing semantics for title, category, default quantities, unit, memo, and duplicate-name spec assignment unless this plan explicitly rejects an ambiguous final `(name, spec)` collision.
- All SQLite text must use single-quoted literals with internal single quotes doubled; do not blacklist quotes, semicolons, comments, backslashes, or newlines.
- Reject NUL, empty exports, invalid non-negative integer fields, and final `(name, spec)` collisions before writing artifacts.
- Use a deterministic Unicode code-point comparator; do not use `localeCompare`.
- Prefix CSV cells whose first non-whitespace character is `=`, `+`, `-`, or `@` with a single quote; do not alter the SQL value.
- Do not add a SQL builder, ORM, CSV package, TOML package, or other dependency.
- Preserve `sqlText` as an export of `scripts/generate-admin-seed.mjs` for existing callers.
- Preserve local `db:seed` and `db:bootstrap:from-notion` behavior.
- Remove `db:bootstrap:remote:from-notion`; production application must be split into generation, review, migration, hash-checked seed, and optional first-bootstrap admin seed.
- Never execute a production D1 mutation from a test.
- Support Node.js 22; do not use Node 24-only APIs.
- Follow RED → GREEN → REFACTOR and commit after each independently reviewable task.

## File Map

- `scripts/sqlite-sql.mjs`: SQLite text literal Interface.
- `scripts/notion-import-core.mjs`: pure parsing, validation, ordering, SQL/CSV/report generation.
- `scripts/import-notion-export.mjs`: filesystem CLI Adapter and report-last commit protocol.
- `scripts/apply-notion-seed.mjs`: reviewed-hash production Adapter.
- `scripts/*.test.mjs`: Node unit and local Wrangler/D1 regression tests.
- `package.json`: safe local/remote commands.
- `README.md`, `docs/design/notion-import-guide.md`, `docs/design/cloudflare-deploy-guide.md`: operator workflow.

---

### Task 1: Share a safe SQLite text literal Interface

**Files:**
- Create: `scripts/sqlite-sql.mjs`
- Create: `scripts/sqlite-sql.test.mjs`
- Modify: `scripts/generate-admin-seed.mjs:3-6,76-78`
- Modify: `scripts/generate-admin-seed.test.mjs:8-15,41-53`

**Interfaces:**
- Produces: `sqlText(value: unknown): string`.
- Consumed by: administrator seed generation and Task 2 Notion SQL generation.

- [ ] **Step 1: Write the failing literal tests**

Create `scripts/sqlite-sql.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { sqlText } from './sqlite-sql.mjs';

test('SQLite text literal은 작은따옴표만 이스케이프하고 나머지 문자를 보존한다', () => {
  assert.equal(sqlText("O'Brien"), "'O''Brien'");
  assert.equal(
    sqlText('x"); DROP TABLE users; --'),
    "'x\"); DROP TABLE users; --'",
  );
  assert.equal(sqlText('line 1\nline 2\\tail; --'), "'line 1\nline 2\\tail; --'");
});

test('SQLite text literal은 NUL을 거부한다', () => {
  assert.throws(
    () => sqlText('before\0after'),
    /SQLite text에는 NUL 문자를 사용할 수 없습니다/,
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test scripts/sqlite-sql.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/sqlite-sql.mjs`.

- [ ] **Step 3: Implement the literal helper**

Create `scripts/sqlite-sql.mjs`:

```js
export function sqlText(value) {
  const text = String(value);
  if (text.includes('\0')) {
    throw new Error('SQLite text에는 NUL 문자를 사용할 수 없습니다.');
  }
  return `'${text.replaceAll("'", "''")}'`;
}
```

In `scripts/generate-admin-seed.mjs`, import and re-export the helper, and delete the local implementation:

```js
import { sqlText } from './sqlite-sql.mjs';

export { sqlText };
```

Keep `buildAdminSeedSql` calling `sqlText` exactly as it does today.

- [ ] **Step 4: Run helper and administrator seed tests**

Run:

```bash
node --test scripts/sqlite-sql.test.mjs scripts/generate-admin-seed.test.mjs
```

Expected: all tests pass, including the existing malicious administrator username case.

- [ ] **Step 5: Commit the shared Interface**

```bash
git add scripts/sqlite-sql.mjs scripts/sqlite-sql.test.mjs \
  scripts/generate-admin-seed.mjs scripts/generate-admin-seed.test.mjs
git commit -m "refactor: share safe SQLite text literals"
```

---

### Task 2: Build deterministic Notion seed artifacts in a pure Module

**Files:**
- Create: `scripts/notion-import-core.mjs`
- Create: `scripts/notion-import-core.test.mjs`

**Interfaces:**
- Consumes: `sqlText(value)` from Task 1.
- Produces: `compareCodePoints`, `parseNotionRecords`, `buildCategorySeedSql`, `buildItemSeedSql`, `buildNotionImportArtifacts`.

- [ ] **Step 1: Write the failing core tests**

Create `scripts/notion-import-core.test.mjs` with fixed-time malicious fixtures:

```js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  buildItemSeedSql,
  buildNotionImportArtifacts,
  compareCodePoints,
} from './notion-import-core.mjs';

const GENERATED_AT = '2026-07-13T00:00:00.000Z';
const files = [
  {
    file: '02-injection.md',
    content: '# x"); DROP TABLE users; --\n분류: 분류\'); DROP TABLE item_categories; --',
  },
  {
    file: '01-quote.md',
    content: "# O'Brien\n분류: 원두\n-- comment",
  },
  {
    file: '03-formula.md',
    content: '# =HYPERLINK("https://evil.invalid")\n',
  },
];

test('악성 text를 SQL data로 보존하고 CSV formula를 중화한다', () => {
  const artifacts = buildNotionImportArtifacts({
    files,
    sourceDir: 'fixture',
    generatedAt: GENERATED_AT,
  });

  assert.match(artifacts.sql, /'x"\); DROP TABLE users; --'/);
  assert.match(artifacts.sql, /'분류''\); DROP TABLE item_categories; --'/);
  assert.match(artifacts.sql, /'O''Brien'/);
  assert.match(artifacts.sql, /VALUES \(NULL, '=HYPERLINK/);
  assert.match(artifacts.csv, /"'=HYPERLINK\(""https:\/\/evil\.invalid""\)"/);
  assert.equal(
    artifacts.report.seedSha256,
    createHash('sha256').update(artifacts.sql, 'utf8').digest('hex'),
  );
});

test('입력 순서와 ICU locale에 관계없이 artifact를 결정론적으로 만든다', () => {
  const forward = buildNotionImportArtifacts({
    files,
    sourceDir: 'fixture',
    generatedAt: GENERATED_AT,
  });
  const reverse = buildNotionImportArtifacts({
    files: [...files].reverse(),
    sourceDir: 'fixture',
    generatedAt: GENERATED_AT,
  });
  assert.equal(reverse.sql, forward.sql);
  assert.equal(reverse.csv, forward.csv);
  assert.deepEqual(reverse.report, forward.report);
  assert.deepEqual(
    ['😀.md', '가.md', 'a.md', 'A.md'].sort(compareCodePoints),
    ['A.md', 'a.md', '가.md', '😀.md'],
  );
});

test('빈 export, NUL, 최종 identity 충돌을 쓰기 전에 거부한다', () => {
  assert.throws(
    () => buildNotionImportArtifacts({ files: [], sourceDir: 'empty', generatedAt: GENERATED_AT }),
    /Markdown 파일이 없습니다/,
  );
  assert.throws(
    () => buildNotionImportArtifacts({
      files: [{ file: 'nul.md', content: '# bad\0name' }],
      sourceDir: 'fixture',
      generatedAt: GENERATED_AT,
    }),
    /nul\.md.*name.*NUL/,
  );
  assert.throws(
    () => buildNotionImportArtifacts({
      files: [
        { file: 'a.md', content: '# same\n분류: beans' },
        { file: 'b.md', content: '# same\n분류: beans' },
        { file: 'c.md', content: '# same\n분류: beans' },
      ],
      sourceDir: 'fixture',
      generatedAt: GENERATED_AT,
    }),
    /same::변형-beans.*b\.md.*c\.md/,
  );
});

test('public item SQL builder도 모든 숫자 field를 검증한다', () => {
  const item = {
    file: 'numeric.md', name: 'numeric', category: '', spec: '', recommended_unit: '개',
    safety_stock: 0, min_stock: 0, current_stock: 0, unit_price: 0, memo: '',
  };
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => buildItemSeedSql([{ ...item, unit_price: invalid }]),
      /unit_price는 0 이상의 안전한 정수/,
    );
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test scripts/notion-import-core.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/notion-import-core.mjs`.

- [ ] **Step 3: Implement deterministic parsing, validation, SQL, CSV, and report generation**

Create `scripts/notion-import-core.mjs` with these exports and exact data rules:

```js
import { createHash } from 'node:crypto';
import path from 'node:path';

import { sqlText } from './sqlite-sql.mjs';

export function compareCodePoints(left, right) {
  const a = Array.from(String(left));
  const b = Array.from(String(right));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function checkedText(value, file, field) {
  const text = String(value);
  if (text.includes('\0')) {
    throw new Error(`${file}의 ${field}에는 NUL 문자를 사용할 수 없습니다.`);
  }
  return text;
}

function checkedNonNegativeInteger(value, file, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${file}의 ${field}는 0 이상의 안전한 정수여야 합니다.`);
  }
  return value;
}

function validateImportItem(item) {
  for (const field of ['name', 'category', 'spec', 'recommended_unit', 'memo']) {
    checkedText(item[field], item.file, field);
  }
  for (const field of ['safety_stock', 'min_stock', 'current_stock', 'unit_price']) {
    checkedNonNegativeInteger(item[field], item.file, field);
  }
}

export function parseNotionRecords(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Notion export에 Markdown 파일이 없습니다.');
  }

  const seenByName = new Map();
  const items = [...files]
    .sort((left, right) => compareCodePoints(left.file, right.file))
    .map(({ file, content }) => {
      const lines = String(content).split(/\r?\n/);
      const titleLine = lines.find((line) => line.trim().startsWith('# ')) || '';
      const fallback = path.parse(file).name.replace(/\s+317830bfc2f[0-9a-f]+$/i, '');
      const name = checkedText(titleLine.replace(/^#\s*/, '').trim() || fallback, file, 'name');
      if (!name) throw new Error(`${file}의 name은 비워둘 수 없습니다.`);
      const categoryLine = lines.find((line) => line.startsWith('분류:'));
      const category = checkedText(
        categoryLine ? categoryLine.replace('분류:', '').trim() : '',
        file,
        'category',
      );
      const seen = seenByName.get(name) ?? 0;
      seenByName.set(name, seen + 1);
      const item = {
        file,
        name,
        category,
        spec: seen > 0 ? `변형-${category || '기본'}` : '',
        safety_stock: 0,
        min_stock: 0,
        current_stock: 0,
        unit_price: 0,
        memo: '',
        recommended_unit: '개',
      };
      for (const field of ['safety_stock', 'min_stock', 'current_stock', 'unit_price']) {
        checkedNonNegativeInteger(item[field], file, field);
      }
      return item;
    });

  const identityFiles = new Map();
  for (const item of items) {
    const identity = `${item.name}::${item.spec}`;
    identityFiles.set(identity, [...(identityFiles.get(identity) ?? []), item.file]);
  }
  const collision = [...identityFiles.entries()].find(([, sourceFiles]) => sourceFiles.length > 1);
  if (collision) {
    throw new Error(`중복 item identity ${collision[0]}: ${collision[1].join(', ')}`);
  }

  return items;
}

export function buildCategorySeedSql(categories) {
  return [...categories]
    .sort(compareCodePoints)
    .map((name) => `INSERT OR IGNORE INTO item_categories (name) VALUES (${sqlText(name)});`);
}

export function buildItemSeedSql(items) {
  return items.map((item) => {
    validateImportItem(item);
    const categoryId = item.category
      ? `(SELECT id FROM item_categories WHERE name = ${sqlText(item.category)} LIMIT 1)`
      : 'NULL';
    const values = [
      categoryId,
      sqlText(item.name),
      sqlText(item.spec),
      sqlText(item.recommended_unit),
      item.safety_stock,
      item.min_stock,
      item.current_stock,
      item.unit_price,
      sqlText(item.memo),
    ];
    return `INSERT OR IGNORE INTO items (category_id, name, spec, unit, safety_stock, min_stock, current_stock, unit_price, memo)\n    VALUES (${values.join(', ')});`;
  });
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildNotionImportArtifacts({ files, sourceDir, generatedAt }) {
  const items = parseNotionRecords(files);
  const categories = new Set(items.map((item) => item.category).filter(Boolean));
  const categoriesSql = buildCategorySeedSql(categories);
  const itemsSql = buildItemSeedSql(items);
  const sql = ['-- Seed categories', ...categoriesSql, '', '-- Seed items', ...itemsSql].join('\n');
  const csvHeader = 'file,name,category,spec,safety_stock,min_stock,current_stock,unit_price,memo\n';
  const csv = csvHeader + items.map((item) => [
    item.file,
    item.name,
    item.category,
    item.spec,
    item.safety_stock,
    item.min_stock,
    item.current_stock,
    item.unit_price,
    item.memo,
  ].map(csvCell).join(',')).join('\n');
  const counts = new Map();
  for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  const report = {
    sourceDir,
    totalFiles: files.length,
    totalItems: items.length,
    totalCategories: categories.size,
    duplicateItemNames: duplicates.length,
    duplicateSample: duplicates.slice(0, 20),
    generatedAt,
    seedSha256: createHash('sha256').update(sql, 'utf8').digest('hex'),
  };
  return { sql, csv, report };
}
```

- [ ] **Step 4: Run core tests and verify GREEN**

Run:

```bash
node --test scripts/notion-import-core.test.mjs
```

Expected: all tests pass and the same fixed input produces byte-identical artifacts.

- [ ] **Step 5: Commit the pure Module**

```bash
git add scripts/notion-import-core.mjs scripts/notion-import-core.test.mjs
git commit -m "fix: generate safe deterministic Notion seed artifacts"
```

---

### Task 3: Make the filesystem CLI report-last and prove generated SQL in local D1

**Files:**
- Modify: `scripts/import-notion-export.mjs`
- Create: `scripts/import-notion-export.test.mjs`

**Interfaces:**
- Consumes: `buildNotionImportArtifacts` from Task 2.
- Produces: `generateNotionImport({ sourceDir, outDir, generatedAt, log }): ImportReport` and the existing CLI command.

- [ ] **Step 1: Write failing Adapter and local D1 tests**

Create `scripts/import-notion-export.test.mjs`. The test must use `fs.mkdtempSync`, create malicious Markdown files dynamically, and assert all of these facts:

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  generateNotionImport,
  writeNotionArtifacts,
} from './import-notion-export.mjs';
import { buildNotionImportArtifacts } from './notion-import-core.mjs';

const WRANGLER_BIN = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);

function runWrangler(args) {
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('세 artifact와 report commit marker를 생성한다', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-notion-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const outDir = path.join(root, 'data');
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, 'attack.md'), '# x"); DROP TABLE users; --\n분류: beans');
  const messages = [];
  const report = generateNotionImport({
    sourceDir,
    outDir,
    generatedAt: '2026-07-13T00:00:00.000Z',
    log: (message) => messages.push(message),
  });
  assert.equal(
    report.seedSha256,
    createHash('sha256').update(
      fs.readFileSync(path.join(outDir, 'seed_categories_items.sql'), 'utf8'),
      'utf8',
    ).digest('hex'),
  );
  assert.equal(messages.length, 1);
  assert.ok(!messages[0].includes('DROP TABLE'));
});
```

Add this validation-failure case:

```js
test('validation 실패는 기존 승인 artifact를 바꾸지 않는다', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-notion-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const outDir = path.join(root, 'data');
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(sourceDir, 'bad.md'), '# before\0after');
  const targets = ['seed_categories_items.sql', 'seed_items.csv', 'import-report.json'];
  for (const target of targets) fs.writeFileSync(path.join(outDir, target), `sentinel-${target}`);
  assert.throws(() => generateNotionImport({ sourceDir, outDir, log: () => {} }), /NUL/);
  for (const target of targets) {
    assert.equal(fs.readFileSync(path.join(outDir, target), 'utf8'), `sentinel-${target}`);
  }
});
```

Add a report-last failure test by injecting a filesystem Adapter whose CSV rename fails after the SQL rename:

```js
test('중간 rename 실패는 승인 report를 남기지 않는다', (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-notion-rename-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outDir, 'import-report.json'), '{"seedSha256":"old"}');
  const artifacts = buildNotionImportArtifacts({
    files: [{ file: 'safe.md', content: '# safe' }],
    sourceDir: 'fixture',
    generatedAt: '2026-07-13T00:00:00.000Z',
  });
  const failingFs = Object.create(fs);
  failingFs.renameSync = (source, target) => {
    if (target.endsWith('seed_items.csv')) throw new Error('TEST_CSV_RENAME_FAILURE');
    return fs.renameSync(source, target);
  };
  assert.throws(
    () => writeNotionArtifacts({ outDir, artifacts, fsImpl: failingFs, token: 'fixed-token' }),
    /TEST_CSV_RENAME_FAILURE/,
  );
  assert.equal(fs.existsSync(path.join(outDir, 'import-report.json')), false);
});
```

Add this local D1 case. It converts expected strings to UTF-8 hex so the verification query never interpolates executable payload text:

```js
test('악성 seed를 local D1에서 data로만 실행한다', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-notion-d1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const outDir = path.join(root, 'data');
  const d1Path = path.join(root, 'd1');
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(
    path.join(sourceDir, 'attack.md'),
    '# x"); DROP TABLE users; --\n분류: 분류\'); DROP TABLE item_categories; --',
  );
  generateNotionImport({ sourceDir, outDir, log: () => {} });
  const seedPath = path.join(outDir, 'seed_categories_items.sql');
  runWrangler(['d1', 'migrations', 'apply', 'hereisorder', '--local', '--persist-to', d1Path]);
  runWrangler([
    'd1', 'execute', 'hereisorder', '--local', '--persist-to', d1Path,
    '--command=CREATE TABLE injection_sentinel (id INTEGER PRIMARY KEY); INSERT INTO injection_sentinel (id) VALUES (1);',
  ]);
  runWrangler(['d1', 'execute', 'hereisorder', '--local', '--persist-to', d1Path, `--file=${seedPath}`]);

  const nameHex = Buffer.from('x"); DROP TABLE users; --', 'utf8').toString('hex');
  const categoryHex = Buffer.from("분류'); DROP TABLE item_categories; --", 'utf8').toString('hex');
  const query = runWrangler([
    'd1', 'execute', 'hereisorder', '--local', '--persist-to', d1Path, '--json',
    `--command=SELECT
      (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'users') AS users_table,
      (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'item_categories') AS categories_table,
      (SELECT COUNT(*) FROM injection_sentinel) AS sentinel_count,
      (SELECT COUNT(*) FROM items WHERE name = CAST(X'${nameHex}' AS TEXT)) AS malicious_item_count,
      (SELECT COUNT(*) FROM item_categories WHERE name = CAST(X'${categoryHex}' AS TEXT)) AS malicious_category_count;`,
  ]);
  const [batch] = JSON.parse(query.stdout);
  assert.deepEqual(batch.results, [{
    users_table: 1,
    categories_table: 1,
    sentinel_count: 1,
    malicious_item_count: 1,
    malicious_category_count: 1,
  }]);
});
```

- [ ] **Step 2: Run the Adapter test and verify RED**

Run:

```bash
node --test scripts/import-notion-export.test.mjs
```

Expected: FAIL because importing the current script executes its top-level CLI and calls `process.exit(1)` when the default folder is absent.
If the repository's ignored `notion-export/` directory exists, the failure instead reports that the current module has no `generateNotionImport` export; either RED proves the CLI is not import-safe.

- [ ] **Step 3: Replace the script with a filesystem Adapter and main guard**

Implement these exact responsibilities in `scripts/import-notion-export.mjs`:

```js
#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNotionImportArtifacts } from './notion-import-core.mjs';

export function writeNotionArtifacts({
  outDir,
  artifacts,
  fsImpl = fs,
  token = randomUUID(),
}) {
  fsImpl.mkdirSync(outDir, { recursive: true });
  const targets = {
    sql: path.join(outDir, 'seed_categories_items.sql'),
    csv: path.join(outDir, 'seed_items.csv'),
    report: path.join(outDir, 'import-report.json'),
  };
  const temporary = Object.fromEntries(
    Object.entries(targets).map(([key, target]) => [key, `${target}.${token}.tmp`]),
  );
  try {
    fsImpl.writeFileSync(temporary.sql, artifacts.sql, { flag: 'wx' });
    fsImpl.writeFileSync(temporary.csv, artifacts.csv, { flag: 'wx' });
    fsImpl.writeFileSync(temporary.report, JSON.stringify(artifacts.report, null, 2), { flag: 'wx' });
    if (fsImpl.existsSync(targets.report)) fsImpl.unlinkSync(targets.report);
    fsImpl.renameSync(temporary.sql, targets.sql);
    fsImpl.renameSync(temporary.csv, targets.csv);
    fsImpl.renameSync(temporary.report, targets.report);
  } catch (error) {
    for (const temporaryPath of Object.values(temporary)) {
      try { fsImpl.unlinkSync(temporaryPath); } catch {}
    }
    throw error;
  }
}

export function generateNotionImport({
  sourceDir = 'notion-export',
  outDir = 'data',
  generatedAt = new Date().toISOString(),
  log = console.log,
} = {}) {
  if (!fs.existsSync(sourceDir)) throw new Error(`notion export folder not found: ${sourceDir}`);
  const names = fs.readdirSync(sourceDir).filter((file) => file.endsWith('.md'));
  const files = names.map((file) => ({
    file,
    content: fs.readFileSync(path.join(sourceDir, file), 'utf8'),
  }));
  const artifacts = buildNotionImportArtifacts({ files, sourceDir, generatedAt });
  writeNotionArtifacts({ outDir, artifacts });

  log(`Notion seed artifacts generated: items=${artifacts.report.totalItems}, categories=${artifacts.report.totalCategories}, sha256=${artifacts.report.seedSha256}`);
  return artifacts.report;
}

function runCli() {
  try {
    generateNotionImport({ sourceDir: process.argv[2] ?? 'notion-export' });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Notion import failed');
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runCli();
```

- [ ] **Step 4: Run Adapter and local D1 tests and verify GREEN**

Run:

```bash
node --test scripts/import-notion-export.test.mjs
```

Expected: all filesystem and local D1 assertions pass; the sentinel table remains present.

- [ ] **Step 5: Commit the CLI Adapter**

```bash
git add scripts/import-notion-export.mjs scripts/import-notion-export.test.mjs
git commit -m "fix: write verified Notion seed artifacts atomically"
```

---

### Task 4: Require the reviewed hash for remote seed application

**Files:**
- Create: `scripts/apply-notion-seed.mjs`
- Create: `scripts/apply-notion-seed.test.mjs`
- Modify: `package.json:23-32`

**Interfaces:**
- Consumes: `data/seed_categories_items.sql`, `data/import-report.json`, `--expected-sha`.
- Produces: `parseApplyArguments`, `verifyNotionSeed`, `applyNotionSeed` and the safe `db:seed:remote` command.

- [ ] **Step 1: Write all pre-mutation guard tests**

Create `scripts/apply-notion-seed.test.mjs` with an injected `runWrangler` spy:

```js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyNotionSeed } from './apply-notion-seed.mjs';

test('모든 hash guard를 통과하기 전에는 Wrangler를 호출하지 않는다', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-apply-seed-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const calls = [];
  const runWrangler = (...args) => { calls.push(args); return { status: 0 }; };
  await assert.rejects(applyNotionSeed({ argv: [], cwd, runWrangler }), /--remote/);
  await assert.rejects(applyNotionSeed({ argv: ['--remote'], cwd, runWrangler }), /--expected-sha/);
  await assert.rejects(
    applyNotionSeed({ argv: ['--remote', '--expected-sha', 'bad'], cwd, runWrangler }),
    /64자리 lowercase SHA-256/,
  );
  assert.equal(calls.length, 0);

  fs.mkdirSync(path.join(cwd, 'data'));
  const seedPath = path.join(cwd, 'data', 'seed_categories_items.sql');
  const reportPath = path.join(cwd, 'data', 'import-report.json');
  fs.writeFileSync(seedPath, 'SELECT 1;');
  const actualSha = createHash('sha256').update('SELECT 1;', 'utf8').digest('hex');
  await assert.rejects(
    applyNotionSeed({ argv: ['--remote', '--expected-sha', actualSha], cwd, runWrangler }),
    /ENOENT/,
  );
  fs.writeFileSync(reportPath, '{bad json');
  await assert.rejects(
    applyNotionSeed({ argv: ['--remote', '--expected-sha', actualSha], cwd, runWrangler }),
    /JSON/,
  );
  fs.writeFileSync(reportPath, JSON.stringify({ seedSha256: '0'.repeat(64) }));
  await assert.rejects(
    applyNotionSeed({ argv: ['--remote', '--expected-sha', actualSha], cwd, runWrangler }),
    /report와 seed SQL/,
  );
  fs.writeFileSync(reportPath, JSON.stringify({ seedSha256: actualSha }));
  await assert.rejects(
    applyNotionSeed({ argv: ['--remote', '--expected-sha', '1'.repeat(64)], cwd, runWrangler }),
    /검토한 SHA-256/,
  );
  assert.equal(calls.length, 0);
});

test('세 hash가 일치할 때만 exact Wrangler args를 한 번 호출한다', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-apply-valid-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'data'));
  const sql = 'SELECT 1;';
  const sha = createHash('sha256').update(sql, 'utf8').digest('hex');
  fs.writeFileSync(path.join(cwd, 'data', 'seed_categories_items.sql'), sql);
  fs.writeFileSync(path.join(cwd, 'data', 'import-report.json'), JSON.stringify({ seedSha256: sha }));
  const calls = [];
  const logs = [];
  await applyNotionSeed({
    argv: ['--remote', '--expected-sha', sha], cwd,
    runWrangler: (args, receivedCwd) => { calls.push({ args, receivedCwd }); return { status: 0 }; },
    log: (message) => logs.push(message),
  });
  assert.deepEqual(calls, [{
    args: ['d1', 'execute', 'hereisorder', '--remote', `--file=${path.join(cwd, 'data', 'seed_categories_items.sql')}`],
    receivedCwd: cwd,
  }]);
  assert.equal(logs[0].includes(sql), false);
  await assert.rejects(
    applyNotionSeed({
      argv: ['--remote', '--expected-sha', sha], cwd,
      runWrangler: () => ({ status: 1, stdout: sql, stderr: sql }),
      log: () => {},
    }),
    /exit 1/,
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test scripts/apply-notion-seed.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement hash verification and direct Wrangler execution**

Create `scripts/apply-notion-seed.mjs` with these guards:

```js
#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WRANGLER_BIN = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

export function parseApplyArguments(argv) {
  let remote = false;
  let expectedSha;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--remote') {
      if (remote) throw new Error('--remote는 한 번만 사용할 수 있습니다.');
      remote = true;
    } else if (value === '--expected-sha') {
      if (expectedSha !== undefined) throw new Error('--expected-sha는 한 번만 사용할 수 있습니다.');
      const candidate = argv[index + 1];
      if (!candidate || candidate.startsWith('--')) throw new Error('--expected-sha 값이 필요합니다.');
      expectedSha = candidate;
      index += 1;
    } else throw new Error(`알 수 없는 옵션입니다: ${value}`);
  }
  if (!remote) throw new Error('production seed 적용에는 --remote가 필요합니다.');
  if (!/^[0-9a-f]{64}$/.test(expectedSha ?? '')) {
    throw new Error('--expected-sha에는 64자리 lowercase SHA-256이 필요합니다.');
  }
  return { expectedSha };
}

export function verifyNotionSeed({ seedPath, reportPath, expectedSha }) {
  const sql = fs.readFileSync(seedPath, 'utf8');
  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
  catch (error) { throw new Error('import report JSON을 해석할 수 없습니다.', { cause: error }); }
  const actualSha = createHash('sha256').update(sql, 'utf8').digest('hex');
  if (report.seedSha256 !== actualSha) throw new Error('report와 seed SQL의 SHA-256이 일치하지 않습니다.');
  if (expectedSha !== actualSha) throw new Error('검토한 SHA-256과 seed SQL이 일치하지 않습니다.');
  return actualSha;
}

function defaultRunWrangler(args, cwd) {
  return spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

export async function applyNotionSeed({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  runWrangler = defaultRunWrangler,
  log = console.log,
} = {}) {
  const { expectedSha } = parseApplyArguments(argv);
  const seedPath = path.join(cwd, 'data', 'seed_categories_items.sql');
  const reportPath = path.join(cwd, 'data', 'import-report.json');
  const actualSha = verifyNotionSeed({ seedPath, reportPath, expectedSha });
  const result = runWrangler([
    'd1', 'execute', 'hereisorder', '--remote', `--file=${seedPath}`,
  ], cwd);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler seed 적용이 exit ${result.status}로 실패했습니다.`);
  log(`Reviewed Notion seed applied: sha256=${actualSha}`);
}
```

Add this exact async main guard:

```js
const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  applyNotionSeed().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Notion seed 적용에 실패했습니다.');
    process.exitCode = 1;
  });
}
```

Do not print captured Wrangler stdout/stderr on either success or failure; generated item/category text may be present in an error. The generic exit-code error plus reviewed SHA is the only operator output.

Add a main guard that prints only the error message and sets `process.exitCode = 1`.

Update `package.json` exactly:

```json
"db:seed:remote": "node scripts/apply-notion-seed.mjs --remote"
```

Delete the `db:bootstrap:remote:from-notion` script. Keep `db:seed`, `db:seed:admin:remote`, `db:bootstrap:from-notion`, and `db:bootstrap:remote` unchanged.

- [ ] **Step 4: Run guard tests and a deliberate preflight failure**

Run:

```bash
node --test scripts/apply-notion-seed.test.mjs
npm run db:seed:remote -- --expected-sha bad
```

Expected: the Node suite passes; the second command exits nonzero with the SHA format error before any Wrangler network call.

- [ ] **Step 5: Commit the remote Adapter**

```bash
git add scripts/apply-notion-seed.mjs scripts/apply-notion-seed.test.mjs package.json
git commit -m "fix: require reviewed hashes for remote Notion seeds"
```

---

### Task 5: Replace operator documentation and run the full gate

**Files:**
- Modify: `README.md:56-60,93-103`
- Modify: `docs/design/notion-import-guide.md`
- Modify: `docs/design/cloudflare-deploy-guide.md:43-62`

**Interfaces:**
- Consumes: safe CLI commands from Tasks 3 and 4.
- Produces: one unambiguous local flow and one reviewed production flow.

- [ ] **Step 1: Replace the production instructions**

Document this exact production sequence in all relevant operator docs:

```bash
npm run import:notion
# data/seed_categories_items.sql, data/seed_items.csv,
# data/import-report.json과 seedSha256을 검토합니다.
npm run db:migrate:remote
npm run db:seed:remote -- --expected-sha <검토한-64자리-SHA-256>
# 최초 bootstrap에서만 실행합니다.
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:seed:admin:remote
```

State explicitly that `db:bootstrap:remote:from-notion` no longer exists, review must precede application, and `data/` remains untracked. Keep the local combined bootstrap command documented.

- [ ] **Step 2: Verify removed unsafe composite references**

Run:

```bash
rg -n "db:bootstrap:remote:from-notion" \
  README.md docs/design package.json
```

Expected: no output and exit code 1.

- [ ] **Step 3: Run all root verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: Node tests, Vitest suites, TypeScript, Wrangler dry-run, and whitespace check all pass.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/design/notion-import-guide.md docs/design/cloudflare-deploy-guide.md
git commit -m "docs: require reviewed Notion seed artifacts"
```

---

## Plan Completion Gate

- The malicious `x"); DROP TABLE ...` fixture executes in local D1 without changing SQL structure or deleting the sentinel.
- SQL and CSV are byte-identical for the same logical input order; report SHA matches actual SQL.
- CSV formula payload is inert while SQL preserves the original text.
- A failed validation leaves the previous approved report and artifacts unchanged.
- Production seed application cannot reach Wrangler without all three matching hashes.
- `db:bootstrap:remote:from-notion` is absent; local bootstrap remains available.
- Root tests, typecheck, build, and `git diff --check` pass.
