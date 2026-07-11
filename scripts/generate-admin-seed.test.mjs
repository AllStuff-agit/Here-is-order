import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PASSWORD_HASH_ITERATIONS,
  buildAdminSeedSql,
  createPasswordHash,
  generateAdminSeed,
  readAdminConfig,
  sqlText,
} from './generate-admin-seed.mjs';

const TEST_PASSWORD = 'a-secure-password';
const TEST_SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

test('현재 Worker와 같은 PBKDF2-SHA256 포맷을 생성한다', () => {
  const expected = pbkdf2Sync(TEST_PASSWORD, TEST_SALT, 100_000, 32, 'sha256').toString('hex');
  const actual = createPasswordHash(TEST_PASSWORD, TEST_SALT);

  assert.equal(
    actual,
    `pbkdf2_sha256$${PASSWORD_HASH_ITERATIONS}$${TEST_SALT.toString('hex')}$${expected}`,
  );
});

test('ADMIN_PASSWORD가 없거나 12자 미만이면 명확히 거부한다', () => {
  assert.throws(
    () => readAdminConfig({}),
    /ADMIN_PASSWORD 환경변수를 설정해야 합니다/,
  );
  assert.throws(
    () => readAdminConfig({ ADMIN_PASSWORD: 'short' }),
    /ADMIN_PASSWORD는 12자 이상이어야 합니다/,
  );
});

test('사용자명과 이름의 작은따옴표를 SQLite 문자열로 안전하게 이스케이프한다', () => {
  assert.equal(sqlText("O'Brien"), "'O''Brien'");

  const sql = buildAdminSeedSql({
    username: "admin'); DROP TABLE users; --",
    passwordHash: 'hash',
    name: "점장 O'Brien",
  });

  assert.match(sql, /VALUES \('admin''\); DROP TABLE users; --', 'hash', '점장 O''Brien', 'admin'/);
  assert.match(sql, /ON CONFLICT\(username\) DO UPDATE SET/);
  assert.match(sql, /role = 'admin'/);
});

test('기본 사용자명과 이름을 사용하고 명시적으로 빈 값은 거부한다', () => {
  assert.deepEqual(readAdminConfig({ ADMIN_PASSWORD: TEST_PASSWORD }), {
    username: 'admin',
    password: TEST_PASSWORD,
    name: '관리자',
  });
  assert.throws(
    () => readAdminConfig({ ADMIN_USERNAME: ' ', ADMIN_PASSWORD: TEST_PASSWORD }),
    /ADMIN_USERNAME 환경변수는 비워둘 수 없습니다/,
  );
  assert.throws(
    () => readAdminConfig({ ADMIN_NAME: ' ', ADMIN_PASSWORD: TEST_PASSWORD }),
    /ADMIN_NAME 환경변수는 비워둘 수 없습니다/,
  );
});

test('없는 data 디렉터리를 만들고 비공개 권한으로 seed만 기록한다', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hereisorder-admin-seed-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const outputPath = path.join(tempDir, 'nested', 'data', 'seed_admin.sql');
  const messages = [];
  generateAdminSeed({
    env: {
      ADMIN_USERNAME: "owner'1",
      ADMIN_PASSWORD: TEST_PASSWORD,
      ADMIN_NAME: "O'Brien 점장",
    },
    outputPath,
    salt: TEST_SALT,
    log: (message) => messages.push(message),
  });

  const sql = fs.readFileSync(outputPath, 'utf8');
  const passwordHash = createPasswordHash(TEST_PASSWORD, TEST_SALT);
  assert.match(sql, /'owner''1'/);
  assert.match(sql, /'O''Brien 점장'/);
  assert.match(sql, /name, role, is_active/);
  assert.match(sql, /role = 'admin'/);
  assert.ok(sql.includes(passwordHash));
  assert.equal(messages.length, 1);
  assert.ok(!messages[0].includes(TEST_PASSWORD));
  assert.ok(!messages[0].includes(passwordHash));

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  }
});

test('검증 실패 시 출력 파일이나 비밀번호를 남기지 않는다', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hereisorder-admin-seed-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const outputPath = path.join(tempDir, 'data', 'seed_admin.sql');
  assert.throws(
    () => generateAdminSeed({
      env: { ADMIN_PASSWORD: 'too-short' },
      outputPath,
      log: () => assert.fail('실패 시 로그 콜백을 호출하면 안 됩니다.'),
    }),
    /12자 이상/,
  );
  assert.equal(fs.existsSync(outputPath), false);
});
