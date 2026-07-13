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
