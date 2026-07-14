import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const readme = fs.readFileSync('README.md', 'utf8');
const guide = fs.readFileSync('docs/design/cloudflare-deploy-guide.md', 'utf8');

function section(contents, start, end) {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `${start} section must exist`);
  assert.ok(endIndex > startIndex, `${end} must follow ${start}`);
  return contents.slice(startIndex, endIndex);
}

test('자동 배포 문서는 checkpoint가 production mutation보다 앞선 exact order를 고정한다', () => {
  const sections = [
    section(readme, '## Cloudflare 자동 배포', '### 수동 복구 배포'),
    section(
      guide,
      '## 4. GitHub Actions 자동 배포',
      '## 5. 배포 후 확인',
    ),
  ];
  const orderedStages = [
    'verify',
    '일회용 원격 D1 rollback contract',
    'production recovery checkpoint',
    'production D1 migration',
    'API Worker 배포',
    'API active version 검증',
    'API `GET /health`와 `GET /ready`',
    '웹 Worker build/deploy',
    '웹 active version 검증',
    '웹/API proxy smoke',
  ];

  for (const contents of sections) {
    let previous = -1;
    for (const stage of orderedStages) {
      const index = contents.indexOf(stage);
      assert.ok(index > previous, `${stage}가 자동 배포 순서에 있어야 합니다.`);
      previous = index;
    }
  }
});

test('runbook은 exact active Worker version과 D1 readiness 증거 위치를 명시한다', () => {
  const runbook = section(
    guide,
    '## 5. 배포 후 확인',
    '## 6. 운영 발주 품목 무결성 감사',
  );
  for (const evidence of [
    'Worker active version verification',
    '`verificationVersion`',
    '`gitSha`',
    '`deploymentId`',
    '`versionId`',
    '`trafficPercentage`',
    '`deploymentUrl`',
    '`outcome`이 `verified`',
    '`GET /ready`',
    '`d1-required-schema-v1`',
  ]) {
    assert.ok(runbook.includes(evidence), `${evidence} active-version/readiness evidence가 필요합니다.`);
  }
  assert.match(guide, /Wrangler deploy NDJSON[^\n]*raw Cloudflare response/);
});

test('runbook은 authoritative summary의 bookmark와 이전 Worker allocation 위치를 명시한다', () => {
  const runbook = section(
    guide,
    '## 5. 배포 후 확인',
    '## 6. 운영 발주 품목 무결성 감사',
  );
  for (const evidence of [
    'GITHUB_STEP_SUMMARY',
    'Production deployment checkpoint',
    '`bookmark`',
    '`previousDeployments.api.deploymentId`',
    '`previousDeployments.api.versions[]`',
    '`previousDeployments.web.deploymentId`',
    '`previousDeployments.web.versions[]`',
    '`versionId`',
    '`percentage`',
  ]) {
    assert.ok(runbook.includes(evidence), `${evidence} evidence 위치가 필요합니다.`);
  }
});

test('runbook은 API와 web의 status 및 version-specific rollback 명령을 고정한다', () => {
  for (const command of [
    'npm exec -- wrangler deployments status --name hereisorder',
    'npm exec -- wrangler deployments status --cwd frontend --name hereisorder-web',
    'npm exec -- wrangler rollback "$API_VERSION_ID" --name hereisorder --message "$INCIDENT_ID"',
    'npm exec -- wrangler rollback "$WEB_VERSION_ID" --cwd frontend --name hereisorder-web --message "$INCIDENT_ID"',
  ]) {
    assert.ok(guide.includes(command), `${command} 명령이 필요합니다.`);
  }
  assert.match(guide, /Worker rollback은 D1을 복원하지 않습니다/);
  assert.match(guide, /forward repair가 기본/);
});

test('phase table은 모든 마지막 성공 지점의 기본 복구 결정을 포함한다', () => {
  const phases = [
    '`verified`',
    '`remote_contract_verified`',
    '`checkpointed`',
    '`migrated`',
    '`api_deployed`',
    '`api_version_verified`',
    '`api_ready_smoked`',
    '`web_deployed`',
    '`web_version_verified`',
    '`web_proxy_smoked`',
  ];
  let previous = -1;
  for (const phase of phases) {
    const index = guide.indexOf(`| ${phase} |`);
    assert.ok(index > previous, `${phase} phase row가 순서대로 필요합니다.`);
    previous = index;
  }
});

test('D1 restore는 보존기간·현재 bookmark·별도 승인을 요구하고 자동화하지 않는다', () => {
  assert.match(guide, /Free[^\n]*7일/);
  assert.match(guide, /Paid[^\n]*30일/);
  assert.match(guide, /파괴적/);
  assert.match(guide, /별도 승인/);
  assert.match(
    guide,
    /Workflow는 Worker rollback이나 D1 restore를 자동 실행하지 않습니다/,
  );

  const currentBookmarkCommand =
    'npm exec -- wrangler d1 time-travel info hereisorder --json';
  const restoreCommand =
    'npm exec -- wrangler d1 time-travel restore hereisorder --bookmark "$TARGET_BOOKMARK"';
  const currentIndex = guide.indexOf(currentBookmarkCommand);
  const restoreIndex = guide.indexOf(restoreCommand);
  assert.ok(currentIndex >= 0, 'restore 전 현재 bookmark 조회 명령이 필요합니다.');
  assert.ok(restoreIndex > currentIndex, '현재 bookmark를 기록한 뒤에만 restore를 안내해야 합니다.');

  assert.doesNotMatch(guide, /CLOUDFLARE_API_TOKEN\s*=\s*['"][^<$\n]+/);
  assert.doesNotMatch(guide, /(?:api[_ -]?token|account[_ -]?id)\s*[:=]\s*[0-9a-z_-]{20,}/i);
});

test('delivery docs define the fixed smoke identity lifecycle without direct D1 edits', () => {
  for (const file of ['README.md', 'docs/design/cloudflare-deploy-guide.md']) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const required of [
      'deployment-smoke',
      'PRODUCTION_SMOKE_PASSWORD',
      'manage-smoke-identity.yml',
      'MANAGE hereisorder deployment-smoke provision',
      'MANAGE hereisorder deployment-smoke disable',
      'MANAGE hereisorder deployment-smoke rotate',
      '모든 세션',
    ]) {
      assert.ok(contents.includes(required), `${file} must include ${required}`);
    }
    const sectionStart = contents.indexOf('운영 smoke identity');
    assert.ok(sectionStart >= 0, `${file} must contain the lifecycle section`);
    const section = contents.slice(sectionStart, sectionStart + 5000);
    assert.ok(section.indexOf('disable') < section.indexOf('rotate'));
    assert.doesNotMatch(section, /UPDATE users|DELETE FROM sessions|wrangler d1 execute/);
  }
});
