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
  await assert.rejects(
    applyNotionSeed({
      argv: ['--remote', '--remote', '--expected-sha', '0'.repeat(64)], cwd, runWrangler,
    }),
    /--remote는 한 번만/,
  );
  await assert.rejects(
    applyNotionSeed({
      argv: ['--remote', '--expected-sha', '0'.repeat(64), '--expected-sha', '0'.repeat(64)],
      cwd,
      runWrangler,
    }),
    /--expected-sha는 한 번만/,
  );
  await assert.rejects(
    applyNotionSeed({ argv: ['--remote', '--unknown'], cwd, runWrangler }),
    /알 수 없는 옵션/,
  );
  await assert.rejects(
    applyNotionSeed({ argv: ['--remote', '--expected-sha'], cwd, runWrangler }),
    /--expected-sha 값이 필요/,
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

test('seed SQL의 raw bytes hash가 일치하지 않으면 Wrangler를 호출하지 않는다', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-apply-raw-bytes-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'data'));
  const replacementBytes = Buffer.from([0xef, 0xbf, 0xbd]);
  const reviewedSha = createHash('sha256').update(replacementBytes).digest('hex');
  fs.writeFileSync(path.join(cwd, 'data', 'seed_categories_items.sql'), Buffer.from([0xff]));
  fs.writeFileSync(
    path.join(cwd, 'data', 'import-report.json'),
    JSON.stringify({ seedSha256: reviewedSha }),
  );
  const calls = [];
  await assert.rejects(
    applyNotionSeed({
      argv: ['--remote', '--expected-sha', reviewedSha],
      cwd,
      runWrangler: (...args) => { calls.push(args); return { status: 0 }; },
      log: () => {},
    }),
    /report와 seed SQL/,
  );
  assert.equal(calls.length, 0);
});

test('검증한 bytes의 private snapshot만 Wrangler에 한 번 전달하고 정리한다', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-apply-valid-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'data'));
  const seedPath = path.join(cwd, 'data', 'seed_categories_items.sql');
  const approvedBytes = Buffer.from('SELECT 1;', 'utf8');
  const sha = createHash('sha256').update(approvedBytes).digest('hex');
  fs.writeFileSync(seedPath, approvedBytes);
  fs.writeFileSync(path.join(cwd, 'data', 'import-report.json'), JSON.stringify({ seedSha256: sha }));
  const calls = [];
  const logs = [];
  let snapshotPath;
  let snapshotBytes;
  let snapshotParentMode;
  let snapshotFileMode;
  await applyNotionSeed({
    argv: ['--remote', '--expected-sha', sha], cwd,
    runWrangler: (args, receivedCwd) => {
      calls.push({ args, receivedCwd });
      fs.writeFileSync(seedPath, 'SELECT MUTATED;');
      snapshotPath = args.find((value) => value.startsWith('--file='))?.slice('--file='.length);
      snapshotBytes = fs.readFileSync(snapshotPath);
      snapshotParentMode = fs.statSync(path.dirname(snapshotPath)).mode & 0o777;
      snapshotFileMode = fs.statSync(snapshotPath).mode & 0o777;
      return { status: 0 };
    },
    log: (message) => logs.push(message),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 4), ['d1', 'execute', 'hereisorder', '--remote']);
  assert.equal(calls[0].args[4], `--file=${snapshotPath}`);
  assert.equal(calls[0].receivedCwd, cwd);
  assert.notEqual(snapshotPath, seedPath);
  assert.deepEqual(snapshotBytes, approvedBytes);
  assert.equal(snapshotParentMode, 0o700);
  assert.equal(snapshotFileMode, 0o600);
  assert.equal(fs.existsSync(snapshotPath), false);
  assert.equal(fs.existsSync(path.dirname(snapshotPath)), false);
  assert.deepEqual(logs, [`Reviewed Notion seed applied: sha256=${sha}`]);

  fs.writeFileSync(seedPath, approvedBytes);
  const failureLogs = [];
  let failureSnapshotPath;
  await assert.rejects(
    applyNotionSeed({
      argv: ['--remote', '--expected-sha', sha], cwd,
      runWrangler: (args) => {
        failureSnapshotPath = args.find((value) => value.startsWith('--file='))?.slice('--file='.length);
        return { status: 1, stdout: approvedBytes.toString('utf8'), stderr: approvedBytes.toString('utf8') };
      },
      log: (message) => failureLogs.push(message),
    }),
    { message: 'Wrangler seed 적용이 exit 1로 실패했습니다.' },
  );
  assert.deepEqual(failureLogs, []);
  assert.equal(fs.existsSync(failureSnapshotPath), false);
  assert.equal(fs.existsSync(path.dirname(failureSnapshotPath)), false);

  fs.writeFileSync(seedPath, approvedBytes);
  const thrownLogs = [];
  let thrownSnapshotPath;
  await assert.rejects(
    applyNotionSeed({
      argv: ['--remote', '--expected-sha', sha], cwd,
      runWrangler: (args) => {
        thrownSnapshotPath = args.find((value) => value.startsWith('--file='))?.slice('--file='.length);
        throw new Error(`attacker output ${thrownSnapshotPath} ${approvedBytes.toString('utf8')}`);
      },
      log: (message) => thrownLogs.push(message),
    }),
    { message: 'Wrangler seed 적용을 시작하지 못했습니다.' },
  );
  assert.deepEqual(thrownLogs, []);
  assert.equal(fs.existsSync(thrownSnapshotPath), false);
  assert.equal(fs.existsSync(path.dirname(thrownSnapshotPath)), false);
});
