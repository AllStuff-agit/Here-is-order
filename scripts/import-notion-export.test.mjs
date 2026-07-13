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
const IMPORT_CLI = fileURLToPath(new URL('./import-notion-export.mjs', import.meta.url));

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

test('CLI 실패 로그는 attacker-controlled collision detail을 노출하지 않는다', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-notion-cli-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, '01-safe.md'), '# ATTACKER_NAME\n분류: safe');
  fs.writeFileSync(
    path.join(sourceDir, '02-ATTACKER_ALPHA.md'),
    '# ATTACKER_NAME\n분류: ATTACKER_CATEGORY',
  );
  fs.writeFileSync(
    path.join(sourceDir, '03-ATTACKER_BETA.md'),
    '# ATTACKER_NAME\n분류: ATTACKER_CATEGORY',
  );

  const result = spawnSync(process.execPath, [IMPORT_CLI, sourceDir], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Notion import failed\n');
  for (const attackerControlled of [
    'ATTACKER_NAME',
    'ATTACKER_CATEGORY',
    '02-ATTACKER_ALPHA.md',
    '03-ATTACKER_BETA.md',
  ]) {
    assert.ok(!result.stderr.includes(attackerControlled));
  }
});

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
