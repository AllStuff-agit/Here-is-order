#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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

function readVerifiedNotionSeed({ seedPath, reportPath, expectedSha }) {
  const seedBytes = fs.readFileSync(seedPath);
  const reportText = fs.readFileSync(reportPath, 'utf8');
  let report;
  try { report = JSON.parse(reportText); }
  catch (error) { throw new Error('import report JSON을 해석할 수 없습니다.', { cause: error }); }
  const actualSha = createHash('sha256').update(seedBytes).digest('hex');
  if (report.seedSha256 !== actualSha) throw new Error('report와 seed SQL의 SHA-256이 일치하지 않습니다.');
  if (expectedSha !== actualSha) throw new Error('검토한 SHA-256과 seed SQL이 일치하지 않습니다.');
  return { actualSha, seedBytes };
}

export function verifyNotionSeed(options) {
  return readVerifiedNotionSeed(options).actualSha;
}

function createPrivateSeedSnapshot(seedBytes) {
  let snapshotDirectory;
  try {
    snapshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-notion-seed-'));
    fs.chmodSync(snapshotDirectory, 0o700);
    const snapshotPath = path.join(snapshotDirectory, 'seed_categories_items.sql');
    const snapshotFile = fs.openSync(snapshotPath, 'wx', 0o600);
    try {
      fs.writeFileSync(snapshotFile, seedBytes);
      fs.fchmodSync(snapshotFile, 0o600);
    } finally {
      fs.closeSync(snapshotFile);
    }
    return { snapshotDirectory, snapshotPath };
  } catch {
    if (snapshotDirectory) {
      try { fs.rmSync(snapshotDirectory, { recursive: true, force: true }); }
      catch { /* Best-effort cleanup before returning a sanitized error. */ }
    }
    throw new Error('검증된 seed 임시 파일을 만들 수 없습니다.');
  }
}

function removePrivateSeedSnapshot(snapshotDirectory) {
  try { fs.rmSync(snapshotDirectory, { recursive: true, force: true }); }
  catch { throw new Error('검증된 seed 임시 파일을 정리하지 못했습니다.'); }
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
  const { actualSha, seedBytes } = readVerifiedNotionSeed({ seedPath, reportPath, expectedSha });
  const { snapshotDirectory, snapshotPath } = createPrivateSeedSnapshot(seedBytes);
  try {
    let result;
    try {
      result = runWrangler([
        'd1', 'execute', 'hereisorder', '--remote', `--file=${snapshotPath}`,
      ], cwd);
    } catch {
      throw new Error('Wrangler seed 적용을 시작하지 못했습니다.');
    }
    if (result.error) throw new Error('Wrangler seed 적용을 시작하지 못했습니다.');
    if (result.status !== 0) throw new Error(`Wrangler seed 적용이 exit ${result.status}로 실패했습니다.`);
    log(`Reviewed Notion seed applied: sha256=${actualSha}`);
  } finally {
    removePrivateSeedSnapshot(snapshotDirectory);
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  applyNotionSeed().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Notion seed 적용에 실패했습니다.');
    process.exitCode = 1;
  });
}
