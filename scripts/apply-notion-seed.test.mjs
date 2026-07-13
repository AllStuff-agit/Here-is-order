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
