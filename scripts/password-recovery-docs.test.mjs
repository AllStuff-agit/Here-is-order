import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const paths = [
  'README.md',
  'docs/design/cloudflare-deploy-guide.md',
  'frontend/app/(app)/settings/page.tsx',
];

test('외부 hash 도구와 raw password update 안내가 없다', () => {
  const combined = paths.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  for (const forbidden of [
    'emn178.github.io',
    'SHA-256 온라인 도구',
    'SET password_hash',
    'UPDATE users',
  ]) {
    assert.equal(combined.includes(forbidden), false, `${forbidden} 안내를 제거해야 합니다.`);
  }
});
