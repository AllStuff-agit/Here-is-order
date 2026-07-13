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

test('자동 배포 문서는 verify와 production migration 사이 rollback gate와 권한을 명시한다', () => {
  const documents = [
    {
      file: 'README.md',
      start: '## Cloudflare 자동 배포',
      end: '### 수동 복구 배포',
    },
    {
      file: 'docs/design/cloudflare-deploy-guide.md',
      start: '## 4. GitHub Actions 자동 배포',
      end: '## 5. 배포 후 확인',
    },
  ];

  for (const { file, start, end } of documents) {
    const contents = fs.readFileSync(file, 'utf8');
    const section = contents.slice(contents.indexOf(start), contents.indexOf(end));
    const verifyIndex = section.indexOf('verify');
    const rollbackIndex = section.indexOf('일회용 원격 D1 rollback contract');
    const migrationIndex = section.indexOf('production D1 migration');

    assert.ok(verifyIndex >= 0, `${file}에 verify 단계를 명시해야 합니다.`);
    assert.ok(
      rollbackIndex > verifyIndex,
      `${file}에서 rollback contract는 verify 뒤에 있어야 합니다.`,
    );
    assert.ok(
      migrationIndex > rollbackIndex,
      `${file}에서 production migration은 rollback contract 뒤에 있어야 합니다.`,
    );
    assert.match(
      section,
      /D1 생성·삭제 권한/,
      `${file}에 disposable D1 생성·삭제 권한을 명시해야 합니다.`,
    );
  }
});
