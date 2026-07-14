import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const readme = fs.readFileSync('README.md', 'utf8');
const guide = fs.readFileSync('docs/design/cloudflare-deploy-guide.md', 'utf8');
const AUTHENTICATED_SMOKE_SEQUENCE =
  'login → me → purchase-order read → logout → old-cookie 401';
const AUTHENTICATED_SMOKE_STAGE =
  `authenticated business smoke: \`${AUTHENTICATED_SMOKE_SEQUENCE}\``;
const AUTHENTICATED_EVIDENCE_HEADING =
  '#### Authenticated business smoke evidence';
const ORPHAN_RECOVERY_HEADING = '#### Orphan session recovery';

function section(contents, start, end) {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `${start} section must exist`);
  assert.ok(endIndex > startIndex, `${end} must follow ${start}`);
  return contents.slice(startIndex, endIndex);
}

function numberedListAfter(contents, leadIn) {
  const leadInIndex = contents.indexOf(leadIn);
  assert.ok(leadInIndex >= 0, `${leadIn} lead-in must exist`);
  const lines = contents
    .slice(leadInIndex + leadIn.length)
    .trimStart()
    .split(/\r?\n/);
  const items = [];
  for (const line of lines) {
    const match = /^([1-9][0-9]*)\. (.+)$/.exec(line);
    if (!match) {
      if (items.length > 0) {
        break;
      }
      continue;
    }
    items.push({ number: Number(match[1]), text: match[2] });
  }
  return items;
}

test('자동 배포 문서는 checkpoint가 production mutation보다 앞선 exact order를 고정한다', () => {
  const sections = [
    {
      contents: section(
        readme,
        '## Cloudflare 자동 배포',
        '### 수동 복구 배포',
      ),
      leadIn: 'Workflow는 다음 순서를 벗어나지 않습니다.',
      label: 'README',
    },
    {
      contents: section(
        guide,
        '## 4. GitHub Actions 자동 배포',
        '## 5. 배포 후 확인',
      ),
      leadIn:
        '위 품질 게이트는 `verify` job에서 실행됩니다. 검증이 성공한 `main` push는 별도 입력이나 승인 없이 아래 순서로 production에 반영됩니다. `workflow_dispatch`는 같은 workflow를 다시 실행하는 복구 경로입니다.',
      label: 'deployment guide',
    },
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
    AUTHENTICATED_SMOKE_STAGE,
  ];

  for (const { contents, label, leadIn } of sections) {
    const items = numberedListAfter(contents, leadIn);
    assert.equal(
      items.length,
      orderedStages.length,
      `${label}: automatic deployment list must contain exactly eleven stages`,
    );
    for (const [index, stage] of orderedStages.entries()) {
      assert.equal(
        items[index].number,
        index + 1,
        `${label}: automatic deployment stages must retain exact numbering`,
      );
      assert.ok(
        items[index].text.includes(stage),
        `${label}: stage ${index + 1} must include ${stage}`,
      );
    }
    assert.equal(
      items.at(-1).text,
      AUTHENTICATED_SMOKE_STAGE,
      `${label}: authenticated business smoke must be the literal final stage`,
    );
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
  const failureRunbook = markdownSection(
    guide,
    '### 5.2 Failure phase별 복구',
  );
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
    '`authenticated_business_smoked`',
  ];
  let previous = -1;
  for (const phase of phases) {
    const index = failureRunbook.indexOf(`| ${phase} |`);
    assert.ok(index > previous, `${phase} phase row가 순서대로 필요합니다.`);
    previous = index;
  }
});

test('repository secret 문서는 initial provision readiness 순서와 workflow 최소 scope를 고정한다', () => {
  const readmeAutomatic = section(
    readme,
    '## Cloudflare 자동 배포',
    '### 수동 복구 배포',
  );
  const guideAutomatic = section(
    guide,
    '## 4. GitHub Actions 자동 배포',
    '## 5. 배포 후 확인',
  );
  for (const [label, contents] of [
    ['README automatic deployment', readmeAutomatic],
    ['deployment guide automatic deployment', guideAutomatic],
  ]) {
    for (const required of [
      'PRODUCTION_SMOKE_PASSWORD',
      'authenticated-business-smoke-v1',
      AUTHENTICATED_SMOKE_SEQUENCE,
      'deploy workflow의 마지막 authenticated business smoke step',
      'lifecycle workflow의 provision/rotate step',
      'disable에는 전달하지',
    ]) {
      assert.ok(contents.includes(required), `${label}: ${required} is required`);
    }
  }

  const secretRows = guideAutomatic.match(
    /^\| Secret \| `PRODUCTION_SMOKE_PASSWORD` \| .* \|$/gm,
  ) ?? [];
  assert.equal(
    secretRows.length,
    1,
    'deployment guide secret table needs exactly one production smoke password row',
  );
  assertOrderedMarkers(secretRows[0], 'production smoke secret readiness', [
    ['base lifecycle deployment', 'base lifecycle deployment 성공'],
    ['stdin-only installation', 'stdin-only'],
    ['create-only provision evidence', 'create-only provision exact whitelist evidence'],
    ['initial provision readiness', 'initial provision readiness'],
    ['authenticated gate activation', 'authenticated gate activation'],
    ['deploy step scope', 'deploy workflow의 마지막 authenticated business smoke step'],
    ['lifecycle step scope', 'lifecycle workflow의 provision/rotate step'],
  ]);
});

test('README 자동 배포 lead-in은 authenticated gate secret과 provision 증거를 모두 요구한다', () => {
  const readmeAutomatic = section(
    readme,
    '## Cloudflare 자동 배포',
    '### 수동 복구 배포',
  );
  const firstFence = readmeAutomatic.indexOf('```bash');
  assert.ok(firstFence >= 0, 'README automatic deployment command fence is required');
  const leadIn = readmeAutomatic.slice(0, firstFence);

  assertOrderedMarkers(leadIn, 'README authenticated gate prerequisites', [
    ['Cloudflare API token', '`CLOUDFLARE_API_TOKEN`'],
    ['Cloudflare account ID', '`CLOUDFLARE_ACCOUNT_ID`'],
    ['authenticated smoke password', '`PRODUCTION_SMOKE_PASSWORD`'],
    ['create-only provision evidence', 'create-only provision exact whitelist evidence'],
    ['completed evidence check', '확인 완료'],
    ['main push', '`main` push'],
    ['fully automatic deployment', '전체 배포가 자동 실행됩니다'],
  ]);
  assert.doesNotMatch(
    leadIn,
    /`CLOUDFLARE_API_TOKEN`과 `CLOUDFLARE_ACCOUNT_ID` repository secret을 한 번 등록한 뒤에는 `main` push만으로 배포됩니다/,
    'two Cloudflare secrets alone must not imply authenticated gate readiness',
  );
});

test('README secret scope는 authenticated seven-field와 lifecycle five-field evidence를 구분한다', () => {
  const readmeAutomatic = section(
    readme,
    '## Cloudflare 자동 배포',
    '### 수동 복구 배포',
  );
  const secretScope = section(
    readmeAutomatic,
    'Repository secret `PRODUCTION_SMOKE_PASSWORD`',
    '\n\nrollback contract',
  );
  assertOrderedMarkers(secretScope, 'README evidence distinction', [
    ['authenticated-only evidence', 'Authenticated smoke 성공 evidence에만'],
    ['authenticated report version', 'authenticated-business-smoke-v1'],
    ['authenticated report shape', 'seven-field whitelist'],
    ['lifecycle evidence', 'Lifecycle operation 성공 evidence는'],
    ['lifecycle report version', 'production-smoke-identity-operation-v1'],
    ['lifecycle report shape', 'five-field whitelist'],
    ['raw values', 'raw secret/password/cookie/token 값'],
    [
      'forbidden surfaces',
      'document, log, error message, summary, artifact, evidence 또는 delivery record',
    ],
  ]);
});

test('permanent delivery docs use durable lifecycle and authenticated-gate terminology', () => {
  for (const [label, contents] of [
    ['README', readme],
    ['deployment guide', guide],
  ]) {
    assert.doesNotMatch(
      contents,
      /\b\x53\x31\b|\b\x53\x32\b/,
      `${label}: transitional wave labels are forbidden`,
    );
    for (const required of [
      'base lifecycle deployment',
      'initial provision readiness',
      'authenticated gate activation',
      'subsequent deployment',
    ]) {
      assert.ok(contents.includes(required), `${label}: durable term ${required} is required`);
    }
  }
});

test('authenticated smoke evidence는 bounded section의 exact seven-field whitelist만 허용한다', () => {
  const evidence = markdownSection(guide, AUTHENTICATED_EVIDENCE_HEADING);
  const evidenceRows = [...evidence.matchAll(
    /^\| `([^`]+)` \| ([^|\n]+) \|$/gm,
  )];
  assert.deepEqual(
    evidenceRows.map((match) => match[1]),
    [
      'smokeVersion',
      'executedAt',
      'gitSha',
      'runId',
      'runAttempt',
      'target',
      'outcome',
    ],
    'authenticated smoke evidence must expose exactly seven ordered fields',
  );
  for (const required of [
    'authenticated-business-smoke-v1',
    '`target` | `web`',
    '`outcome` | `verified`',
    'seven-field whitelist',
    'five-field lifecycle evidence',
    'Password',
    'cookie/token',
    'identity projection',
    'query sentinel',
    'response header/body',
    'business row/count',
    'raw URL/error/exception',
    'Cloudflare envelope',
    'log, error message, summary, artifact, evidence 또는 delivery record',
  ]) {
    assert.ok(evidence.includes(required), `authenticated evidence must include ${required}`);
  }
  assert.doesNotMatch(
    evidence,
    /`(?:operationVersion|databaseName|action)`|`completed`/,
    'authenticated evidence must stay distinct from lifecycle evidence fields',
  );

  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  assert.doesNotMatch(
    lifecycle,
    /`smokeVersion`|authenticated-business-smoke-v1|`runId`|`runAttempt`|`target`/,
    'lifecycle evidence must not absorb authenticated evidence fields',
  );
});

test('post-deploy checklist와 orphan recovery는 final gate와 exact revoke/rotate 순서를 고정한다', () => {
  const checklist = section(
    guide,
    '## 5. 배포 후 확인',
    '### 5.1 Production checkpoint 증거',
  );
  for (const required of [
    AUTHENTICATED_SMOKE_SEQUENCE,
    'authenticated-business-smoke-v1',
    'seven-field whitelist evidence',
  ]) {
    assert.ok(checklist.includes(required), `post-deploy checklist needs ${required}`);
  }

  const failureRunbook = markdownSection(
    guide,
    '### 5.2 Failure phase별 복구',
  );
  const recovery = markdownSection(failureRunbook, ORPHAN_RECOVERY_HEADING);
  assertOrderedMarkers(recovery, 'orphan session recovery', [
    ['runner termination risk', 'Runner termination'],
    ['orphan session', 'orphan session'],
    ['lifecycle disable', 'lifecycle runbook의 `disable`'],
    ['disable evidence', 'disable exact whitelist evidence'],
    ['stdin-only replacement secret', '새 secret을 stdin-only'],
    ['rotate evidence', 'rotate exact whitelist evidence'],
    ['fresh main dispatch', 'fresh main `workflow_dispatch`'],
    ['fresh run success', 'fresh run이 성공'],
    [
      'exact authenticated report',
      'exactly one `authenticated-business-smoke-v1` seven-field report',
    ],
    [
      'fresh run metadata match',
      'report의 `gitSha`, `runId`, `runAttempt`가 fresh run',
    ],
    ['exact fresh metadata values', 'exact Git SHA, run ID, run attempt'],
  ]);
  assert.ok(
    recovery.includes(
      '이전 실패 run의 GitHub `Re-run jobs`와 `gh run rerun`을 사용하지 않습니다.',
    ),
    'orphan recovery must forbid both GitHub rerun mechanisms for the failed run',
  );
  for (const prohibition of [
    'provision을 호출하지 않',
    'sessions row를 직접 조회하거나 출력하지 않',
  ]) {
    assert.ok(recovery.includes(prohibition), `orphan recovery needs ${prohibition}`);
  }
  assert.doesNotMatch(
    recovery,
    /re-dispatch/,
    'orphan recovery must use precise GitHub rerun terminology',
  );
  const failedFreshRunIndex = recovery.indexOf('fresh run이 실패');
  assert.ok(failedFreshRunIndex >= 0, 'failed fresh run recovery must exist');
  const failedFreshRun = recovery.slice(failedFreshRunIndex);
  assertOrderedMarkers(failedFreshRun, 'failed fresh run fail-closed recovery', [
    ['unresolved orphan risk', 'orphan risk를 fail-closed로 미해결'],
    ['repeat disable evidence', 'disable exact whitelist evidence'],
    ['repeat stdin-only secret', '새 secret stdin-only 설치'],
    ['repeat rotate evidence', 'rotate exact whitelist evidence'],
    ['separate fresh run', '별도의 fresh main `workflow_dispatch`'],
  ]);
  assert.equal(
    fencedBlocks(recovery).length,
    0,
    'orphan recovery must refer to the lifecycle runbook without duplicating commands',
  );
});

test('general deployment recovery는 authenticated/orphan recovery precedence를 보존한다', () => {
  const failureRunbook = markdownSection(
    guide,
    '### 5.2 Failure phase별 복구',
  );
  const generalRecovery = markdownSection(
    failureRunbook,
    '#### General deployment recovery',
  );
  assertOrderedMarkers(generalRecovery, 'general recovery precedence', [
    ['authenticated smoke started', 'authenticated business smoke가 시작됐거나'],
    ['orphan risk unresolved', 'orphan risk를 배제할 수 없으면'],
    ['exclusive orphan recovery', '앞의 **Orphan session recovery**만 적용'],
    [
      'failed run reruns remain forbidden',
      '이전 run의 GitHub `Re-run jobs`와 `gh run rerun`은 계속 금지',
    ],
    ['general phase recovery', '일반 phase-specific rerun/recovery는'],
    [
      'pre-authenticated-only failures',
      'authenticated business smoke가 시작되기 전 실패에만 제한',
    ],
    ['actual state first', '실제 Cloudflare 상태'],
    ['last successful phase', '마지막 성공 phase'],
  ]);
  assert.doesNotMatch(
    generalRecovery,
    /실패한 run을 재실행하기 전/,
    'general recovery must not leave rerun guidance unqualified',
  );
  assert.equal(
    fencedBlocks(generalRecovery).length,
    0,
    'general recovery precedence needs no duplicated command block',
  );
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

const README_LIFECYCLE_HEADING = '### 운영 smoke identity';
const GUIDE_LIFECYCLE_HEADING = '### 운영 smoke identity lifecycle';
const PROVISION_HEADING = '#### 최초 provision';
const ROTATION_HEADING = '#### Credential rotation과 긴급 비활성화';
const SECRET_ASSIGNMENT =
  'smoke_password="$(openssl rand -base64 48 | tr \'+/\' \'-_\' | tr -d \'=\\n\')"';
const SECRET_INSTALL =
  'printf \'%s\' "$smoke_password" | gh secret set PRODUCTION_SMOKE_PASSWORD --repo AllStuff-agit/Here-is-order';
const LIFECYCLE_ACTIONS = ['provision', 'disable', 'rotate'];
const WORKFLOW_DISPATCH = 'gh workflow run manage-smoke-identity.yml';
const OPERATION_COMMAND_PATTERN =
  /\bgh\s+workflow\s+run\s+manage-smoke-identity\.yml\b|\bgh\s+run\s+(?:watch|view)\b|(?:^|\s)-f\s+(?:action|confirmation)=|(?:provision|disable|rotate)_(?:run_(?:url|id)|report_(?:matches|count))=/im;
const STANDALONE_GH_TOKEN_PATTERN =
  /(?:^|[^a-z0-9_-])gh(?=$|[^a-z0-9_-])/i;
const DIRECT_DATABASE_COMMAND_PATTERN =
  /\bwrangler\s+d1\b|\b(?:curl|wget|sqlite3)\b/i;
const SQL_STATEMENT_PATTERN =
  /\b(?:insert\s+(?:or\s+(?:rollback|abort|replace|fail|ignore)\s+)?into|update\s+(?:or\s+(?:rollback|abort|replace|fail|ignore)\s+)?(?:"[^"\n]+"|`[^`\n]+`|\[[^\]\n]+\]|(?:(?:main|temp)\.)?[a-z_][a-z0-9_]*)|delete\s+from|merge\s+into|replace\s+into|upsert\s+into|create\s+(?:or\s+replace\s+)?(?:(?:temp|temporary)\s+)?(?:unique\s+)?(?:virtual\s+)?(?:table|index|view|trigger)\b|alter\s+(?:table|index|view|trigger)\b|drop\s+(?:table|index|view|trigger)\b|rename\s+(?:table|index|view|trigger)\b|comment\s+on\s+(?:table|index|view|trigger)\b|truncate\s+(?:table\s+)?[a-z_][a-z0-9_]*|pragma\s+[a-z_][a-z0-9_]*|attach\s+database|detach\s+database|with\s+[a-z_][a-z0-9_]*\s+as\s*\(|select\b[^\n;]{0,500}\bfrom\b|analyze(?:\s+[a-z_][a-z0-9_.]*)?\s*;|vacuum(?:\s+[a-z_][a-z0-9_]*)?(?:\s+into\s+(?:'[^'\n]+'|"[^"\n]+"|`[^`\n]+`|[a-z_][a-z0-9_.-]*))?\s*;|reindex(?:\s+[a-z_][a-z0-9_]*)?\s*;|begin(?:\s+(?:deferred|immediate|exclusive))?(?:\s+(?:transaction|work))?\s*;|end(?:\s+(?:transaction|work))?\s*;|savepoint\s+[a-z_][a-z0-9_]*\s*;|release(?:\s+savepoint)?\s+[a-z_][a-z0-9_]*\s*;|commit(?:\s+(?:transaction|work))?\s*;|rollback(?:\s+(?:transaction|work))?(?:\s+to(?:\s+savepoint)?\s+[a-z_][a-z0-9_]*)?\s*;)/i;
const GUIDE_D1_CONSOLE_PROHIBITION_SENTENCE =
  'Identity lifecycle은 main의 `manage-smoke-identity.yml` 수동 workflow로만 수행하며 D1 콘솔이나 임의 SQL로 변경하지 않는다.';
const README_D1_CONSOLE_PROHIBITION_SENTENCE =
  'Identity lifecycle은 main의 `Manage production smoke identity` 수동 workflow만 사용하며 D1 콘솔이나 임의 SQL로 변경하지 않습니다.';
const D1_CONSOLE_REFERENCE_SOURCE = String.raw`D1\s*(?:console|콘솔)`;
const UNAPPROVED_D1_CONSOLE_REFERENCE_PATTERN = new RegExp(
  D1_CONSOLE_REFERENCE_SOURCE,
  'i',
);

const EXPECTED_CREDENTIAL_BODY = [
  'set +x',
  'set -euo pipefail',
  String.raw`smoke_password="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"`,
  'test "${#smoke_password}" -ge 32',
  `printf '%s' "$smoke_password" | gh secret set PRODUCTION_SMOKE_PASSWORD --repo AllStuff-agit/Here-is-order`,
  'unset smoke_password',
  '',
].join('\n');

const EXPECTED_PROVISION_BODY = [
  'set -euo pipefail',
  'provision_run_url="$(gh workflow run manage-smoke-identity.yml --ref main \\',
  '  -f action=provision \\',
  `  -f confirmation='MANAGE hereisorder deployment-smoke provision')"`,
  String.raw`if [[ ! "$provision_run_url" =~ ^https://github\.com/AllStuff-agit/Here-is-order/actions/runs/([1-9][0-9]*)$ ]]; then`,
  '  exit 1',
  'fi',
  'provision_run_id="${BASH_REMATCH[1]}"',
  'gh run watch "$provision_run_id" --exit-status',
  `test "$(gh run view "$provision_run_id" --json databaseId --jq '.databaseId')" = "$provision_run_id"`,
  `test "$(gh run view "$provision_run_id" --json event --jq '.event')" = 'workflow_dispatch'`,
  `test "$(gh run view "$provision_run_id" --json headBranch --jq '.headBranch')" = 'main'`,
  `test "$(gh run view "$provision_run_id" --json workflowName --jq '.workflowName')" = 'Manage production smoke identity'`,
  `test "$(gh run view "$provision_run_id" --json url --jq '.url')" = "$provision_run_url"`,
  String.raw`provision_report_matches="$(gh run view "$provision_run_id" --log | rg -o '\{"operationVersion":"production-smoke-identity-operation-v1","executedAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z","databaseName":"hereisorder","action":"provision","outcome":"completed"\}')"`,
  String.raw`provision_report_count="$(printf '%s\n' "$provision_report_matches" | sed '/^$/d' | wc -l | tr -d ' ')"`,
  'test "$provision_report_count" -eq 1',
  'unset provision_report_matches provision_report_count',
  '',
].join('\n');

const EXPECTED_DISABLE_BODY = [
  'set -euo pipefail',
  'disable_run_url="$(gh workflow run manage-smoke-identity.yml --ref main \\',
  '  -f action=disable \\',
  `  -f confirmation='MANAGE hereisorder deployment-smoke disable')"`,
  String.raw`if [[ ! "$disable_run_url" =~ ^https://github\.com/AllStuff-agit/Here-is-order/actions/runs/([1-9][0-9]*)$ ]]; then`,
  '  exit 1',
  'fi',
  'disable_run_id="${BASH_REMATCH[1]}"',
  'gh run watch "$disable_run_id" --exit-status',
  `test "$(gh run view "$disable_run_id" --json databaseId --jq '.databaseId')" = "$disable_run_id"`,
  `test "$(gh run view "$disable_run_id" --json event --jq '.event')" = 'workflow_dispatch'`,
  `test "$(gh run view "$disable_run_id" --json headBranch --jq '.headBranch')" = 'main'`,
  `test "$(gh run view "$disable_run_id" --json workflowName --jq '.workflowName')" = 'Manage production smoke identity'`,
  `test "$(gh run view "$disable_run_id" --json url --jq '.url')" = "$disable_run_url"`,
  String.raw`disable_report_matches="$(gh run view "$disable_run_id" --log | rg -o '\{"operationVersion":"production-smoke-identity-operation-v1","executedAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z","databaseName":"hereisorder","action":"disable","outcome":"completed"\}')"`,
  String.raw`disable_report_count="$(printf '%s\n' "$disable_report_matches" | sed '/^$/d' | wc -l | tr -d ' ')"`,
  'test "$disable_report_count" -eq 1',
  'unset disable_report_matches disable_report_count',
  '',
].join('\n');

const EXPECTED_ROTATE_BODY = [
  'set -euo pipefail',
  'rotate_run_url="$(gh workflow run manage-smoke-identity.yml --ref main \\',
  '  -f action=rotate \\',
  `  -f confirmation='MANAGE hereisorder deployment-smoke rotate')"`,
  String.raw`if [[ ! "$rotate_run_url" =~ ^https://github\.com/AllStuff-agit/Here-is-order/actions/runs/([1-9][0-9]*)$ ]]; then`,
  '  exit 1',
  'fi',
  'rotate_run_id="${BASH_REMATCH[1]}"',
  'gh run watch "$rotate_run_id" --exit-status',
  `test "$(gh run view "$rotate_run_id" --json databaseId --jq '.databaseId')" = "$rotate_run_id"`,
  `test "$(gh run view "$rotate_run_id" --json event --jq '.event')" = 'workflow_dispatch'`,
  `test "$(gh run view "$rotate_run_id" --json headBranch --jq '.headBranch')" = 'main'`,
  `test "$(gh run view "$rotate_run_id" --json workflowName --jq '.workflowName')" = 'Manage production smoke identity'`,
  `test "$(gh run view "$rotate_run_id" --json url --jq '.url')" = "$rotate_run_url"`,
  String.raw`rotate_report_matches="$(gh run view "$rotate_run_id" --log | rg -o '\{"operationVersion":"production-smoke-identity-operation-v1","executedAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z","databaseName":"hereisorder","action":"rotate","outcome":"completed"\}')"`,
  String.raw`rotate_report_count="$(printf '%s\n' "$rotate_report_matches" | sed '/^$/d' | wc -l | tr -d ' ')"`,
  'test "$rotate_report_count" -eq 1',
  'unset rotate_report_matches rotate_report_count',
  '',
].join('\n');

const EXPECTED_LIFECYCLE_BODIES = [
  EXPECTED_CREDENTIAL_BODY,
  EXPECTED_PROVISION_BODY,
  EXPECTED_DISABLE_BODY,
  EXPECTED_CREDENTIAL_BODY,
  EXPECTED_ROTATE_BODY,
];

const LIFECYCLE_TOKENS = [
  ['fixed identity', 'deployment-smoke'],
  ['repository secret', 'PRODUCTION_SMOKE_PASSWORD'],
  ['manual workflow', 'manage-smoke-identity.yml'],
  ['provision confirmation', 'MANAGE hereisorder deployment-smoke provision'],
  ['disable confirmation', 'MANAGE hereisorder deployment-smoke disable'],
  ['rotate confirmation', 'MANAGE hereisorder deployment-smoke rotate'],
  ['session revocation', '모든 세션'],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markdownSection(contents, exactHeading) {
  const levelMatch = /^(#{1,6}) /.exec(exactHeading);
  assert.ok(levelMatch, `${exactHeading} must be a Markdown heading`);
  const headingMatches = [...contents.matchAll(new RegExp(
    `^${escapeRegExp(exactHeading)}\\r?$`,
    'gm',
  ))];
  assert.equal(
    headingMatches.length,
    1,
    `${exactHeading} exact heading must exist exactly once`,
  );
  const [headingMatch] = headingMatches;

  const bodyStart = headingMatch.index + headingMatch[0].length;
  const remainder = contents.slice(bodyStart);
  const boundary = new RegExp(`^#{1,${levelMatch[1].length}}\\s+`, 'm').exec(
    remainder,
  );
  const end = boundary ? bodyStart + boundary.index : contents.length;
  return contents.slice(headingMatch.index, end);
}

function markdownLines(contents) {
  return [...contents.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0].length > 0)
    .map((match) => {
      const text = match[0].endsWith('\n') ? match[0].slice(0, -1) : match[0];
      return {
        start: match.index,
        end: match.index + match[0].length,
        contentEnd: match.index + text.length,
        text,
      };
    });
}

function fencedBlocks(contents) {
  const lines = markdownLines(contents);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/.exec(lines[index].text);
    if (!opening) {
      continue;
    }

    const fenceCharacter = opening[1][0];
    const closingPattern = new RegExp(
      `^ {0,3}${escapeRegExp(fenceCharacter)}{${opening[1].length},}[ \\t]*\\r?$`,
    );
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      if (closingPattern.test(lines[candidate].text)) {
        closingIndex = candidate;
        break;
      }
    }
    assert.ok(
      closingIndex >= 0,
      `Markdown fence parser: fence at offset ${lines[index].start} must close`,
    );

    blocks.push({
      body: contents.slice(lines[index].end, lines[closingIndex].start),
      end: lines[closingIndex].end,
      fenceCharacter,
      full: contents.slice(lines[index].start, lines[closingIndex].contentEnd),
      info: opening[2].trim(),
      start: lines[index].start,
    });
    index = closingIndex;
  }
  return blocks;
}

function fencedBashBlocks(contents) {
  return fencedBlocks(contents).filter(({ info }) => info === 'bash');
}

function nonFenceSegments(contents, blocks = fencedBlocks(contents)) {
  const segments = [];
  let cursor = 0;
  for (const block of blocks) {
    segments.push(contents.slice(cursor, block.start));
    cursor = block.end;
  }
  segments.push(contents.slice(cursor));
  return segments;
}

function countOccurrences(contents, marker) {
  assert.notEqual(marker, '', 'occurrence marker must not be empty');
  let count = 0;
  let offset = 0;
  while (true) {
    const index = contents.indexOf(marker, offset);
    if (index < 0) {
      return count;
    }
    count += 1;
    offset = index + marker.length;
  }
}

function workflowInputValues(contents, name) {
  const pattern = new RegExp(
    `(?:^|\\s)-f[ \\t]+${escapeRegExp(name)}=([^\\s\\\\]+)`,
    'g',
  );
  return [...contents.matchAll(pattern)].map((match) => match[1]);
}

function assertLifecycleTokens(contents, label) {
  for (const [name, token] of LIFECYCLE_TOKENS) {
    assert.ok(
      contents.includes(token),
      `${label}: ${name} must stay inside bounded lifecycle section`,
    );
  }
}

function assertOrderedMarkers(contents, label, markers) {
  let previousIndex = -1;
  let previousName = 'section start';
  for (const [name, marker] of markers) {
    const index = contents.indexOf(marker, previousIndex + 1);
    assert.ok(
      index > previousIndex,
      `${label}: ${name} must follow ${previousName}`,
    );
    previousIndex = index;
    previousName = name;
  }
}

function operationReportPattern(action) {
  return String.raw`\{"operationVersion":"production-smoke-identity-operation-v1","executedAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z","databaseName":"hereisorder","action":"${action}","outcome":"completed"\}`;
}

function assertOperationCompletionMarkers(contents, action) {
  const reportExtraction = `${action}_report_matches="$(gh run view "$${action}_run_id" --log | rg -o '${operationReportPattern(action)}')"`;
  for (const [name, marker] of [
    [`${action} watch exact run`, `gh run watch "$${action}_run_id" --exit-status`],
    [`${action} exact whitelist extraction`, reportExtraction],
    [`${action} exact whitelist evidence`, `test "$${action}_report_count" -eq 1`],
  ]) {
    assert.ok(contents.includes(marker), `${name} semantic check failed`);
  }
}

function assertOperationEvidence(contents, action) {
  const reportExtraction = `${action}_report_matches="$(gh run view "$${action}_run_id" --log | rg -o '${operationReportPattern(action)}')"`;
  const reportCount = `${action}_report_count="$(printf '%s\\n' "$${action}_report_matches" | sed '/^$/d' | wc -l | tr -d ' ')"`;
  const required = [
    [
      `${action} URL capture`,
      `${action}_run_url="$(gh workflow run manage-smoke-identity.yml --ref main ${'\\'}`,
    ],
    [`${action} action`, `-f action=${action} ${'\\'}`],
    [
      `${action} confirmation`,
      `-f confirmation='MANAGE hereisorder deployment-smoke ${action}')"`,
    ],
    [
      `${action} exact repository URL`,
      `if [[ ! "$${action}_run_url" =~ ^https://github\\.com/AllStuff-agit/Here-is-order/actions/runs/([1-9][0-9]*)$ ]]; then`,
    ],
    [`${action} run ID`, `${action}_run_id="${'${BASH_REMATCH[1]}'}"`],
    [`${action} watch`, `gh run watch "$${action}_run_id" --exit-status`],
    [
      `${action} database ID metadata`,
      `test "$(gh run view "$${action}_run_id" --json databaseId --jq '.databaseId')" = "$${action}_run_id"`,
    ],
    [
      `${action} event metadata`,
      `test "$(gh run view "$${action}_run_id" --json event --jq '.event')" = 'workflow_dispatch'`,
    ],
    [
      `${action} branch metadata`,
      `test "$(gh run view "$${action}_run_id" --json headBranch --jq '.headBranch')" = 'main'`,
    ],
    [
      `${action} workflow metadata`,
      `test "$(gh run view "$${action}_run_id" --json workflowName --jq '.workflowName')" = 'Manage production smoke identity'`,
    ],
    [
      `${action} URL metadata`,
      `test "$(gh run view "$${action}_run_id" --json url --jq '.url')" = "$${action}_run_url"`,
    ],
    [`${action} whitelist extraction`, reportExtraction],
    [`${action} whitelist count`, reportCount],
    [`${action} exactly one report`, `test "$${action}_report_count" -eq 1`],
    [
      `${action} whitelist cleanup`,
      `unset ${action}_report_matches ${action}_report_count`,
    ],
  ];

  assert.equal(
    countOccurrences(contents, WORKFLOW_DISPATCH),
    1,
    `${action} operation uniqueness: one workflow dispatch is required`,
  );
  assert.equal(
    workflowInputValues(contents, 'action').length,
    1,
    `${action} operation uniqueness: one action flag is required`,
  );
  assert.equal(
    workflowInputValues(contents, 'confirmation').length,
    1,
    `${action} operation uniqueness: one confirmation is required`,
  );
  for (const [name, marker] of required) {
    assert.equal(
      countOccurrences(contents, marker),
      1,
      `${action} operation uniqueness: ${name} must appear exactly once`,
    );
  }
  assertOrderedMarkers(contents, `${action} operation`, required);
}

function assertExecutableActionOrder(contents) {
  assertOrderedMarkers(contents, 'rotation executable order', [
    ['disable dispatch', '-f action=disable \\'],
    ['rotate dispatch', '-f action=rotate \\'],
  ]);
}

function assertProvisionOrder(contents) {
  assertOrderedMarkers(contents, 'provision lifecycle order', [
    ['base lifecycle deployment', 'base lifecycle deployment가 성공'],
    ['initial secret assignment', SECRET_ASSIGNMENT],
    ['initial secret install', SECRET_INSTALL],
    [
      'provision dispatch',
      'provision_run_url="$(gh workflow run manage-smoke-identity.yml',
    ],
    ['provision watch', 'gh run watch "$provision_run_id" --exit-status'],
    [
      'provision exact whitelist evidence',
      'test "$provision_report_count" -eq 1',
    ],
    ['five-field JSON declaration', 'exactly one five-field whitelist JSON evidence'],
    ['initial provision readiness', 'initial provision readiness'],
    ['authenticated gate activation', 'authenticated gate activation'],
  ]);
}

function assertRotationOrder(contents) {
  assertExecutableActionOrder(contents);
  assertOrderedMarkers(contents, 'rotation lifecycle order', [
    [
      'disable dispatch',
      'disable_run_url="$(gh workflow run manage-smoke-identity.yml',
    ],
    ['disable watch', 'gh run watch "$disable_run_id" --exit-status'],
    ['disable exact whitelist evidence', 'test "$disable_report_count" -eq 1'],
    ['new secret assignment', SECRET_ASSIGNMENT],
    ['new secret install', SECRET_INSTALL],
    [
      'rotate dispatch',
      'rotate_run_url="$(gh workflow run manage-smoke-identity.yml',
    ],
    ['rotate watch', 'gh run watch "$rotate_run_id" --exit-status'],
    ['rotate exact whitelist evidence', 'test "$rotate_report_count" -eq 1'],
  ]);
}

function assertCredentialSafety(contents) {
  const credentialBlocks = fencedBashBlocks(contents).filter(
    ({ body }) => /PRODUCTION_SMOKE_PASSWORD|smoke_password|openssl rand/.test(body),
  );
  assert.equal(
    credentialBlocks.length,
    2,
    'credential safety: initial and replacement credentials need separate bash blocks',
  );

  for (const { body } of credentialBlocks) {
    const commandLines = body.split(/\r?\n/).filter((line) => line.trim() !== '');
    assert.equal(commandLines[0], 'set +x', 'credential safety: set +x must be first');
    assert.equal(
      commandLines[1],
      'set -euo pipefail',
      'credential safety: strict mode must follow set +x',
    );
    assert.equal(
      body.split(SECRET_ASSIGNMENT).length - 1,
      1,
      'credential safety: exact 48-byte URL-safe assignment is required once',
    );
    assert.equal(
      body.split(SECRET_INSTALL).length - 1,
      1,
      'credential safety: exact stdin secret install is required once',
    );
    assertOrderedMarkers(body, 'credential safety', [
      ['disable shell tracing', 'set +x'],
      ['strict shell mode', 'set -euo pipefail'],
      ['secret assignment', SECRET_ASSIGNMENT],
      ['stdin secret install', SECRET_INSTALL],
      ['secret cleanup', 'unset smoke_password'],
    ]);
    assert.deepEqual(
      commandLines.filter((line) => line.includes('smoke_password')),
      [
        SECRET_ASSIGNMENT,
        'test "${#smoke_password}" -ge 32',
        SECRET_INSTALL,
        'unset smoke_password',
      ],
      'credential safety: secret variable may appear only in exact in-memory lifecycle commands',
    );
    assert.doesNotMatch(body, /\becho\b/i, 'credential safety: echo is forbidden');
    assert.doesNotMatch(body, /\btee\b/i, 'credential safety: tee/file output is forbidden');
    assert.doesNotMatch(
      body,
      /\bset\s+(?:-x|-o\s+xtrace)\b/i,
      'credential safety: shell tracing must not be re-enabled',
    );
    assert.doesNotMatch(
      body,
      /gh secret set[^\n]*(?:--body(?:-file)?|-b\b|\$smoke_password|<<?<?)/i,
      'credential safety: secret argv/file alternatives are forbidden',
    );
    assert.doesNotMatch(
      body,
      /\$smoke_password[^\n|]*(?:>>?|2>)/,
      'credential safety: secret file redirection is forbidden',
    );
  }

  assert.match(contents, /stdout, argv, file, chat, issue, PR 또는 commit/);
}

function assertNoDirectDatabaseMutation(contents, label, prohibitionSentence) {
  assert.equal(
    countOccurrences(contents, prohibitionSentence),
    1,
    `${label}: exact D1 console prohibition sentence is required once`,
  );
  const neutralizedContents = contents.replace(prohibitionSentence, '');
  const blocks = fencedBlocks(neutralizedContents);
  const scanTargets = [
    ...blocks.map(({ body }, index) => [`fence ${index + 1}`, body]),
    ...nonFenceSegments(neutralizedContents, blocks).map((body, index) => [
      `inline section ${index + 1}`,
      body,
    ]),
  ];
  for (const [target, body] of scanTargets) {
    assert.doesNotMatch(
      body,
      DIRECT_DATABASE_COMMAND_PATTERN,
      `${label}: direct Wrangler D1 commands are forbidden in ${target}`,
    );
    assert.doesNotMatch(
      body,
      UNAPPROVED_D1_CONSOLE_REFERENCE_PATTERN,
      `${label}: unapproved D1 console references are forbidden in ${target}`,
    );
    assert.doesNotMatch(
      body,
      SQL_STATEMENT_PATTERN,
      `${label}: SQL DML/DDL is forbidden in ${target}`,
    );
  }
}

function assertEvidenceSafety(contents, label) {
  assert.match(contents, /D1 콘솔이나 임의 SQL로 변경하지 않/);
  assert.match(
    contents,
    /Password, hash, user\/session row, raw D1 envelope는 evidence가 아니다/,
    `${label}: evidence exclusions are required`,
  );
  assert.match(
    contents,
    /whitelist evidence가 없거나 malformed이면/,
    `${label}: missing or malformed evidence must stop progress`,
  );
  assert.match(contents, /raw production response를 출력하지 않/);
}

function assertNoRawLogExposure(contents) {
  const logLines = contents.match(/^.*gh run view .* --log.*$/gm) ?? [];
  const allowedLines = ['provision', 'disable', 'rotate'].map(
    (action) =>
      `${action}_report_matches="$(gh run view "$${action}_run_id" --log | rg -o '${operationReportPattern(action)}')"`,
  );
  assert.deepEqual(
    logLines.toSorted(),
    allowedLines.toSorted(),
    'log safety: only three exact whitelist rg -o extractions may consume logs',
  );
}

function classifyLifecycleBlock(block, index) {
  const credential =
    /PRODUCTION_SMOKE_PASSWORD|smoke_password|openssl rand/.test(block.body);
  const dispatchCount = countOccurrences(block.body, WORKFLOW_DISPATCH);
  const actionFlags = workflowInputValues(block.body, 'action');

  if (credential) {
    assert.equal(
      dispatchCount,
      0,
      `lifecycle block shape: credential block ${index + 1} must not dispatch`,
    );
    assert.doesNotMatch(
      block.body,
      OPERATION_COMMAND_PATTERN,
      `lifecycle block shape: credential block ${index + 1} must contain no operation commands`,
    );
    return 'credential';
  }

  assert.equal(
    dispatchCount,
    1,
    `lifecycle block shape: operation block ${index + 1} needs one dispatch`,
  );
  assert.equal(
    actionFlags.length,
    1,
    `lifecycle block shape: operation block ${index + 1} needs one action flag`,
  );
  return actionFlags[0];
}

function assertLifecycleBlockStructure(contents) {
  assert.equal(
    countOccurrences(contents, WORKFLOW_DISPATCH),
    3,
    'lifecycle command uniqueness: exactly three workflow dispatches are required',
  );
  const blocks = fencedBlocks(contents);
  assert.equal(
    blocks.length,
    5,
    'lifecycle block shape: exactly five fenced blocks are required',
  );
  for (const [index, block] of blocks.entries()) {
    assert.equal(
      block.info,
      'bash',
      `lifecycle block shape: fence ${index + 1} must be tagged exactly bash`,
    );
  }

  const kinds = blocks.map(classifyLifecycleBlock);
  assert.deepEqual(
    kinds,
    ['credential', 'provision', 'disable', 'credential', 'rotate'],
    'lifecycle block shape: ordered kinds must be credential/provision/disable/credential/rotate',
  );
  assert.equal(
    kinds.filter((kind) => kind === 'credential').length,
    2,
    'lifecycle block shape: exactly two credential blocks are required',
  );
  for (const action of LIFECYCLE_ACTIONS) {
    assert.equal(
      kinds.filter((kind) => kind === action).length,
      1,
      `lifecycle block shape: exactly one ${action} block is required`,
    );
  }

  for (const [index, segment] of nonFenceSegments(contents, blocks).entries()) {
    assert.doesNotMatch(
      segment,
      OPERATION_COMMAND_PATTERN,
      `lifecycle block shape: operation commands are forbidden outside fences at segment ${index + 1}`,
    );
    assert.doesNotMatch(
      segment,
      STANDALONE_GH_TOKEN_PATTERN,
      `lifecycle block shape: unowned gh commands are forbidden outside exact lifecycle bodies at segment ${index + 1}`,
    );
  }

  const operationBlocks = new Map();
  for (const [index, kind] of kinds.entries()) {
    if (kind !== 'credential') {
      operationBlocks.set(kind, blocks[index]);
      assertOperationEvidence(blocks[index].body, kind);
    }
  }
  for (const [index, block] of blocks.entries()) {
    assert.equal(
      block.body,
      EXPECTED_LIFECYCLE_BODIES[index],
      `lifecycle command allowlist: ${kinds[index]} block must match its exact expected body`,
    );
  }

  const provision = markdownSection(contents, PROVISION_HEADING);
  const rotation = markdownSection(contents, ROTATION_HEADING);
  assertCredentialSafety(contents);
  assertProvisionOrder(provision);
  assertRotationOrder(rotation);
  return { blocks, kinds, operationBlocks };
}

test('delivery docs keep every fixed lifecycle token inside exact bounded sections', () => {
  assertLifecycleTokens(
    markdownSection(readme, README_LIFECYCLE_HEADING),
    'README lifecycle',
  );
  assertLifecycleTokens(
    markdownSection(guide, GUIDE_LIFECYCLE_HEADING),
    'deployment guide lifecycle',
  );
});

test('README lifecycle summary fixes initial provision and rotation handoff ordering', () => {
  const lifecycle = markdownSection(readme, README_LIFECYCLE_HEADING);
  assertOrderedMarkers(lifecycle, 'README provision order', [
    ['base lifecycle deployment', 'base lifecycle deployment 성공'],
    ['secret installation', 'secret 설치'],
    ['provision dispatch', 'MANAGE hereisorder deployment-smoke provision'],
    ['provision success', 'provision run 성공'],
    ['provision evidence', 'provision exact whitelist evidence'],
    ['initial provision readiness', 'initial provision readiness'],
    ['authenticated gate activation', 'authenticated gate activation'],
  ]);
  assertOrderedMarkers(lifecycle, 'README rotation order', [
    ['disable dispatch', 'MANAGE hereisorder deployment-smoke disable'],
    ['disable success', 'disable run 성공'],
    ['disable evidence', 'disable exact whitelist evidence'],
    ['new secret installation', '새 secret 설치'],
    ['rotate dispatch', 'MANAGE hereisorder deployment-smoke rotate'],
    ['rotate success', 'rotate run 성공'],
    ['rotate evidence', 'rotate exact whitelist evidence'],
  ]);
  assert.match(lifecycle, /모든 세션을 폐기/);
  assert.match(lifecycle, /evidence가 없거나 malformed이면/);
  assert.match(lifecycle, /D1 콘솔이나 임의 SQL로 변경하지 않습니다/);
  assert.match(
    lifecycle,
    /Password, hash, user\/session row, raw production response는 evidence가 아닙니다/,
  );
});

test('deployment guide validates exact provision and rotation runs before progress', () => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  assertLifecycleBlockStructure(lifecycle);
});

test('credential blocks disable tracing and install exact 48-byte URL-safe secrets only through stdin', () => {
  assertCredentialSafety(markdownSection(guide, GUIDE_LIFECYCLE_HEADING));
});

test('lifecycle runbook forbids direct database mutation and unsafe evidence inspection', () => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  assertNoDirectDatabaseMutation(
    lifecycle,
    'deployment guide lifecycle',
    GUIDE_D1_CONSOLE_PROHIBITION_SENTENCE,
  );
  assertNoDirectDatabaseMutation(
    markdownSection(readme, README_LIFECYCLE_HEADING),
    'README lifecycle',
    README_D1_CONSOLE_PROHIBITION_SENTENCE,
  );
  assertEvidenceSafety(lifecycle, 'deployment guide lifecycle');
  assertNoRawLogExposure(lifecycle);
});

test('bounded lifecycle check rejects required content moved beyond the next heading', () => {
  const marker = 'MANAGE hereisorder deployment-smoke rotate';
  const withoutMarker = guide.replace(marker, 'ROTATE_CONFIRMATION_MOVED');
  const mutated = withoutMarker.replace(
    '## 5. 배포 후 확인',
    `## 5. 배포 후 확인\n\n${marker}`,
  );
  const lifecycle = markdownSection(mutated, GUIDE_LIFECYCLE_HEADING);
  assert.throws(
    () => assertLifecycleTokens(lifecycle, 'bounded-section mutation'),
    /bounded-section mutation: rotate confirmation must stay inside bounded lifecycle section/,
  );
});

test('database mutation semantic check rejects lowercase SQL DML in a bash fence', () => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  const mutated = lifecycle.replace('```bash\n', '```bash\nupdate users set active = 0;\n');
  assert.throws(
    () => assertNoDirectDatabaseMutation(
      mutated,
      'lowercase DML mutation',
      GUIDE_D1_CONSOLE_PROHIBITION_SENTENCE,
    ),
    /lowercase DML mutation: SQL DML\/DDL is forbidden/,
  );
});

test('rotation semantic check rejects swapped executable disable and rotate blocks', () => {
  const rotation = markdownSection(
    markdownSection(guide, GUIDE_LIFECYCLE_HEADING),
    ROTATION_HEADING,
  );
  assertExecutableActionOrder(rotation);
  const bashBlocks = fencedBashBlocks(rotation);
  const disableBlock = bashBlocks.find(({ body }) => body.includes('-f action=disable'));
  const rotateBlock = bashBlocks.find(({ body }) => body.includes('-f action=rotate'));
  assert.ok(disableBlock, 'disable executable block must exist before mutation');
  assert.ok(rotateBlock, 'rotate executable block must exist before mutation');
  const mutated = rotation
    .replace(disableBlock.full, 'DISABLE_BLOCK_PLACEHOLDER')
    .replace(rotateBlock.full, disableBlock.full)
    .replace('DISABLE_BLOCK_PLACEHOLDER', rotateBlock.full);
  assert.throws(
    () => assertExecutableActionOrder(mutated),
    /rotation executable order: rotate dispatch must follow disable dispatch/,
  );
});

test('operation semantic checks reject missing watch and exact evidence', () => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  const { operationBlocks } = assertLifecycleBlockStructure(lifecycle);
  const provision = operationBlocks.get('provision').body;
  assertOperationCompletionMarkers(provision, 'provision');
  const missingWatch = provision.replace(
    'gh run watch "$provision_run_id" --exit-status',
    'WATCH_REMOVED',
  );
  assert.throws(
    () => assertOperationCompletionMarkers(missingWatch, 'provision'),
    /provision watch exact run semantic check failed/,
  );
  const missingEvidence = provision.replace(
    'test "$provision_report_count" -eq 1',
    'EVIDENCE_REMOVED',
  );
  assert.throws(
    () => assertOperationCompletionMarkers(missingEvidence, 'provision'),
    /provision exact whitelist evidence semantic check failed/,
  );
});

test('rotation semantic check rejects secret replacement before disable completion', () => {
  const rotation = markdownSection(
    markdownSection(guide, GUIDE_LIFECYCLE_HEADING),
    ROTATION_HEADING,
  );
  assertRotationOrder(rotation);
  const credentialBlock = fencedBashBlocks(rotation).find(({ body }) =>
    body.includes(SECRET_ASSIGNMENT),
  );
  assert.ok(credentialBlock, 'rotation credential block must exist before mutation');
  const withoutCredential = rotation.replace(credentialBlock.full, '');
  const disableDispatch = withoutCredential.indexOf('disable_run_url=');
  assert.ok(disableDispatch >= 0, 'disable dispatch must exist before mutation');
  const mutated =
    withoutCredential.slice(0, disableDispatch)
    + `${credentialBlock.full}\n\n`
    + withoutCredential.slice(disableDispatch);
  assert.throws(
    () => assertRotationOrder(mutated),
    /rotation lifecycle order: new secret assignment must follow disable exact whitelist evidence/,
  );
});

test('database mutation invariant scans non-bash, untagged, uppercase, and tilde fences', async (t) => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  for (const [name, fence] of [
    ['sh-tagged lowercase DML', '```sh\nupdate users set active = 0;\n```'],
    ['untagged lowercase DML', '```\nupdate users set active = 0;\n```'],
    ['uppercase shell tag', '```BASH\nupdate users set active = 0;\n```'],
    ['tilde shell fence', '~~~shell\nupdate users set active = 0;\n~~~'],
  ]) {
    await t.test(name, () => {
      const mutated = lifecycle.replace(
        PROVISION_HEADING,
        `${PROVISION_HEADING}\n\n${fence}`,
      );
      assert.throws(
        () => assertNoDirectDatabaseMutation(
          mutated,
          `${name} mutation`,
          GUIDE_D1_CONSOLE_PROHIBITION_SENTENCE,
        ),
        /SQL DML\/DDL is forbidden/,
      );
    });
  }
});

test('database mutation invariant scans inline lifecycle commands case-insensitively', async (t) => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  for (const [name, command, expected] of [
    [
      'mixed-case Wrangler D1',
      'WrAnGlEr D1 execute hereisorder --remote',
      /direct Wrangler D1 commands are forbidden/,
    ],
    [
      'inline lowercase SQL',
      'update users set active = 0;',
      /SQL DML\/DDL is forbidden/,
    ],
  ]) {
    await t.test(name, () => {
      const mutated = lifecycle.replace(
        PROVISION_HEADING,
        `${PROVISION_HEADING}\n\n\`${command}\``,
      );
      assert.throws(
        () => assertNoDirectDatabaseMutation(
          mutated,
          `${name} mutation`,
          GUIDE_D1_CONSOLE_PROHIBITION_SENTENCE,
        ),
        expected,
      );
    });
  }
});

test('lifecycle block shape requires exact bash tags and accepts a tilde bash fence', async (t) => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  const [firstBlock] = fencedBlocks(lifecycle);
  assert.ok(firstBlock, 'first lifecycle fence must exist before retagging');
  for (const tag of ['sh', 'shell', 'BASH', '']) {
    await t.test(`rejects ${tag || 'untagged'} fence`, () => {
      const retagged = firstBlock.full.replace(/^```bash/m, `\`\`\`${tag}`);
      const mutated = lifecycle.replace(firstBlock.full, retagged);
      assert.throws(
        () => assertLifecycleBlockStructure(mutated),
        /must be tagged exactly bash/,
      );
    });
  }

  await t.test('accepts tilde fence tagged bash', () => {
    const tildeBlock = firstBlock.full
      .replace(/^```bash$/m, '~~~bash')
      .replace(/^```$/m, '~~~');
    const mutated = lifecycle.replace(firstBlock.full, tildeBlock);
    assert.doesNotThrow(() => assertLifecycleBlockStructure(mutated));
  });
});

test('lifecycle block shape rejects operation commands outside classified blocks', () => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  const command = 'gh run watch "$provision_run_id" --exit-status';
  const mutated = lifecycle.replace(
    PROVISION_HEADING,
    `${PROVISION_HEADING}\n\n\`${command}\``,
  );
  assert.throws(
    () => assertLifecycleBlockStructure(mutated),
    /operation commands are forbidden outside fences/,
  );
});

test('lifecycle block shape rejects every standalone gh command outside fences', async (t) => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  for (const [name, command] of [
    [
      'quoted workflow ID',
      `gh workflow run "manage-smoke-identity.yml" --ref main --raw-field action=rotate`,
    ],
    [
      'repository selector before workflow',
      `gh -R AllStuff-agit/Here-is-order workflow run 123456789 --ref main`,
    ],
  ]) {
    await t.test(name, () => {
      const mutated = lifecycle.replace(
        PROVISION_HEADING,
        `${PROVISION_HEADING}\n\n\`${command}\``,
      );
      assert.throws(
        () => assertLifecycleBlockStructure(mutated),
        /unowned gh commands are forbidden outside exact lifecycle bodies/,
      );
    });
  }
});

test('lifecycle block shape rejects an early duplicate rotate dispatch', () => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  const rotation = markdownSection(lifecycle, ROTATION_HEADING);
  const blocks = fencedBashBlocks(rotation);
  const disableBlock = blocks.find(({ body }) => body.includes('-f action=disable'));
  const rotateBlock = blocks.find(({ body }) => body.includes('-f action=rotate'));
  assert.ok(disableBlock, 'disable executable block must exist before duplication');
  assert.ok(rotateBlock, 'rotate executable block must exist before duplication');
  const mutated = lifecycle.replace(
    disableBlock.full,
    `${rotateBlock.full}\n\n${disableBlock.full}`,
  );
  assert.throws(
    () => assertLifecycleBlockStructure(mutated),
    /lifecycle command uniqueness: exactly three workflow dispatches are required/,
  );
});

test('operation uniqueness rejects a duplicated provision watch', () => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  const watch = 'gh run watch "$provision_run_id" --exit-status';
  const mutated = lifecycle.replace(watch, `${watch}\n${watch}`);
  assert.throws(
    () => assertLifecycleBlockStructure(mutated),
    /provision operation uniqueness: provision watch must appear exactly once/,
  );
});

test('operation uniqueness rejects extra action and confirmation flags', async (t) => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  for (const [name, extraFlag, expected] of [
    [
      'action',
      '-f action=unexpected \\',
      /one action flag/,
    ],
    [
      'confirmation',
      "-f confirmation='unexpected')",
      /provision operation uniqueness: one confirmation is required/,
    ],
  ]) {
    await t.test(name, () => {
      const mutated = lifecycle.replace(
        '-f action=provision \\',
        `-f action=provision \\\n${extraFlag}`,
      );
      assert.throws(() => assertLifecycleBlockStructure(mutated), expected);
    });
  }
});

test('lifecycle block shape rejects operation markers split across fences', () => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  const provisionBlock = fencedBashBlocks(lifecycle).find(({ body }) =>
    body.includes('-f action=provision'),
  );
  assert.ok(provisionBlock, 'provision executable block must exist before splitting');
  const watch = 'gh run watch "$provision_run_id" --exit-status';
  const splitIndex = provisionBlock.body.indexOf(watch);
  assert.ok(splitIndex > 0, 'provision watch must exist before splitting');
  const beforeWatch = provisionBlock.body.slice(0, splitIndex).trimEnd();
  const fromWatch = provisionBlock.body.slice(splitIndex).trimEnd();
  const splitBlocks = `\`\`\`bash\n${beforeWatch}\n\`\`\`\n\n\`\`\`bash\n${fromWatch}\n\`\`\``;
  const mutated = lifecycle.replace(provisionBlock.full, splitBlocks);
  assert.throws(
    () => assertLifecycleBlockStructure(mutated),
    /lifecycle block shape: exactly five fenced blocks are required/,
  );
});

test('lifecycle command allowlist rejects unowned commands and formatting changes', async (t) => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  const provisionBlock = fencedBashBlocks(lifecycle).find(({ body }) =>
    body.includes('-f action=provision'),
  );
  assert.ok(provisionBlock, 'provision block must exist before allowlist mutations');
  const watch = 'gh run watch "$provision_run_id" --exit-status';
  for (const [name, mutatedBody] of [
    [
      'literal watch for an unowned run',
      provisionBlock.body.replace(watch, `gh run watch 123456789 --exit-status\n${watch}`),
    ],
    [
      'reformatted strict-mode command',
      provisionBlock.body.replace('set -euo pipefail', 'set  -euo pipefail'),
    ],
    [
      'direct curl command',
      provisionBlock.body.replace(watch, `curl https://example.invalid\n${watch}`),
    ],
    [
      'direct SQL command',
      provisionBlock.body.replace(watch, `UPDATE users SET active = 0;\n${watch}`),
    ],
    [
      'unowned shell command',
      provisionBlock.body.replace(watch, `printf '%s\\n' unexpected\n${watch}`),
    ],
  ]) {
    await t.test(name, () => {
      const mutatedBlock = provisionBlock.full.replace(
        provisionBlock.body,
        mutatedBody,
      );
      const mutated = lifecycle.replace(provisionBlock.full, mutatedBlock);
      assert.throws(
        () => assertLifecycleBlockStructure(mutated),
        /lifecycle command allowlist: provision block must match its exact expected body/,
      );
    });
  }
});

test('lifecycle command allowlist rejects alternate workflow dispatch spellings', async (t) => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  const disableBlock = fencedBashBlocks(lifecycle).find(({ body }) =>
    body.includes('-f action=disable'),
  );
  const provisionBlock = fencedBashBlocks(lifecycle).find(({ body }) =>
    body.includes('-f action=provision'),
  );
  assert.ok(disableBlock, 'disable block must exist before alternate dispatch mutation');
  assert.ok(provisionBlock, 'provision block must exist before long-form flag mutation');

  await t.test('early double-spaced raw-field rotate dispatch', () => {
    const earlyRotate = "gh  workflow run manage-smoke-identity.yml --ref main --raw-field action=rotate --raw-field confirmation='MANAGE hereisorder deployment-smoke rotate'";
    const mutatedBody = disableBlock.body.replace(
      'set -euo pipefail',
      `set -euo pipefail\n${earlyRotate}`,
    );
    const mutated = lifecycle.replace(
      disableBlock.full,
      disableBlock.full.replace(disableBlock.body, mutatedBody),
    );
    assert.throws(
      () => assertLifecycleBlockStructure(mutated),
      /lifecycle command allowlist: disable block must match its exact expected body/,
    );
  });

  for (const [name, extraFlags] of [
    [
      'short typed field',
      "  -F action=provision \\\n  -F confirmation='MANAGE hereisorder deployment-smoke provision' \\",
    ],
    [
      'long typed field',
      "  --field action=provision \\\n  --field confirmation='MANAGE hereisorder deployment-smoke provision' \\",
    ],
    [
      'long raw field',
      "  --raw-field action=provision \\\n  --raw-field confirmation='MANAGE hereisorder deployment-smoke provision' \\",
    ],
  ]) {
    await t.test(`duplicate ${name} action and confirmation`, () => {
      const canonicalConfirmation =
        "  -f confirmation='MANAGE hereisorder deployment-smoke provision')\"";
      const mutatedBody = provisionBlock.body.replace(
        canonicalConfirmation,
        `${extraFlags}\n${canonicalConfirmation}`,
      );
      const mutated = lifecycle.replace(
        provisionBlock.full,
        provisionBlock.full.replace(provisionBlock.body, mutatedBody),
      );
      assert.throws(
        () => assertLifecycleBlockStructure(mutated),
        /lifecycle command allowlist: provision block must match its exact expected body/,
      );
    });
  }
});

test('database invariant rejects affirmative D1 console mutation instructions', async (t) => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  for (const [name, instruction] of [
    [
      'Korean instruction',
      '운영자는 D1 콘솔에서 deployment-smoke 사용자 row를 직접 변경한다.',
    ],
    [
      'English instruction',
      'Use the D1 console to modify the deployment-smoke user.',
    ],
    [
      'Korean management instruction',
      '운영자는 D1 콘솔에서 deployment-smoke 사용자 row를 직접 관리한다.',
    ],
  ]) {
    await t.test(name, () => {
      const mutated = lifecycle.replace(
        PROVISION_HEADING,
        `${PROVISION_HEADING}\n\n${instruction}`,
      );
      assert.throws(
        () => assertNoDirectDatabaseMutation(
          mutated,
          `${name} mutation`,
          GUIDE_D1_CONSOLE_PROHIBITION_SENTENCE,
        ),
        /unapproved D1 console references are forbidden/,
      );
    });
  }
});

test('database invariant scans the README lifecycle for D1 console instructions', () => {
  const lifecycle = markdownSection(readme, README_LIFECYCLE_HEADING);
  assert.doesNotThrow(() =>
    assertNoDirectDatabaseMutation(
      lifecycle,
      'README lifecycle',
      README_D1_CONSOLE_PROHIBITION_SENTENCE,
    ),
  );
  const mutated = lifecycle.replace(
    README_LIFECYCLE_HEADING,
    `${README_LIFECYCLE_HEADING}\n\n운영자는 D1 콘솔에서 deployment-smoke 사용자를 직접 변경합니다.`,
  );
  assert.throws(
    () => assertNoDirectDatabaseMutation(
      mutated,
      'README lifecycle mutation',
      README_D1_CONSOLE_PROHIBITION_SENTENCE,
    ),
    /unapproved D1 console references are forbidden/,
  );
});

test('database invariant rejects conflict-clause and expanded DDL statements', async (t) => {
  const lifecycle = markdownSection(guide, GUIDE_LIFECYCLE_HEADING);
  for (const [name, payload] of [
    [
      'non-fence CREATE TEMP TABLE',
      '`CREATE TEMP TABLE smoke_probe(id INTEGER);`',
    ],
    [
      'alternate-fence CREATE TEMP TABLE',
      '~~~sql\nCREATE TEMP TABLE smoke_probe(id INTEGER);\n~~~',
    ],
    [
      'INSERT OR IGNORE INTO',
      '`INSERT OR IGNORE INTO users(id) VALUES (1);`',
    ],
    [
      'CREATE UNIQUE INDEX',
      '```SQL\nCREATE UNIQUE INDEX smoke_probe_idx ON users(id);\n```',
    ],
    [
      'CREATE TEMPORARY VIEW',
      '```text\nCREATE TEMPORARY VIEW smoke_probe AS SELECT 1;\n```',
    ],
    [
      'ALTER TRIGGER',
      '`ALTER TRIGGER smoke_probe ENABLE;`',
    ],
    [
      'ANALYZE',
      '`ANALYZE users;`',
    ],
    [
      'VACUUM INTO',
      "`VACUUM INTO 'smoke-backup.db';`",
    ],
    [
      'END TRANSACTION',
      '`END TRANSACTION;`',
    ],
    [
      'SAVEPOINT',
      '`SAVEPOINT smoke_probe;`',
    ],
    [
      'RELEASE SAVEPOINT',
      '`RELEASE SAVEPOINT smoke_probe;`',
    ],
  ]) {
    await t.test(name, () => {
      const mutated = lifecycle.replace(
        PROVISION_HEADING,
        `${PROVISION_HEADING}\n\n${payload}`,
      );
      assert.throws(
        () => assertNoDirectDatabaseMutation(
          mutated,
          `${name} mutation`,
          GUIDE_D1_CONSOLE_PROHIBITION_SENTENCE,
        ),
        /SQL DML\/DDL is forbidden/,
      );
    });
  }
});
