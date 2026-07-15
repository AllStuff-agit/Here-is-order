import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const deployGuide = fs.readFileSync('docs/design/cloudflare-deploy-guide.md', 'utf8');
const checklist = fs.readFileSync('docs/design/implementation-checklist-v1.md', 'utf8');
const designSpec = fs.readFileSync(
  'docs/superpowers/specs/2026-07-15-wave-2-identity-session-deep-module-design.md',
  'utf8',
);
const wave2aPlan = fs.readFileSync(
  'docs/superpowers/plans/2026-07-15-wave-2a-identity-characterization-contract.md',
  'utf8',
);
const readme = fs.readFileSync('README.md', 'utf8');

const deployGuideRequired = [
  'CLOUDFLARE_D1_READ_TOKEN',
  'audit-identity-compatibility.yml',
  'built-in `github.token`',
  'audit 명령 직전',
  'live remote `main` SHA',
  '`GITHUB_SHA`',
  'audit 명령 성공 직후',
  'identity-compatibility-v1',
  'auditVersion',
  'executedAt',
  'gitSha',
  'requestId',
  'legacyPasswordHashCount',
  'unsupportedPasswordHashCount',
  'invalidIdentityProjectionCount',
  'outcome',
  'unsupportedPasswordHashCount = 0',
  'invalidIdentityProjectionCount = 0',
  'Wave 2B',
  'evidence를 소비하기 직전',
  'merge SHA',
];

const checklistRequired = [
  'CLOUDFLARE_D1_READ_TOKEN',
  'merge',
  'deploy',
  'exact main SHA',
  'audit-identity-compatibility.yml',
  'audit 명령 직전과 직후',
  'live remote `main` SHA',
  '`GITHUB_SHA`',
  'unsupportedPasswordHashCount = 0',
  'invalidIdentityProjectionCount = 0',
  'Wave 2B',
  'evidence 사용 직전',
  'merge SHA',
];

const readmeRequired = [
  'audit-identity-compatibility.yml',
  'zero-count gate',
  'docs/design/cloudflare-deploy-guide.md#identity-compatibility-audit',
];

const reportFields = [
  'auditVersion',
  'executedAt',
  'gitSha',
  'requestId',
  'legacyPasswordHashCount',
  'unsupportedPasswordHashCount',
  'invalidIdentityProjectionCount',
  'outcome',
];

const secretInstallLines = [
  'set +x',
  'set -euo pipefail',
  'IFS= read -r -s D1_READ_TOKEN',
  `printf '%s' "$D1_READ_TOKEN" | gh secret set CLOUDFLARE_D1_READ_TOKEN --repo AllStuff-agit/Here-is-order`,
  'unset D1_READ_TOKEN',
];

function assertInOrder(text, markers) {
  let previousIndex = -1;
  for (const marker of markers) {
    const index = text.indexOf(marker, previousIndex + 1);
    assert.ok(index > previousIndex, `${marker} must appear in order`);
    previousIndex = index;
  }
}

function extractH2(text, heading) {
  const lines = text.split(/\r?\n/);
  const expected = `## ${heading}`;
  const start = lines.findIndex((line) => line === expected);
  if (start < 0) {
    throw new Error(`${expected} section must exist`);
  }
  const next = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start, next < 0 ? lines.length : next).join('\n');
}

function extractH3(text, heading) {
  const lines = text.split(/\r?\n/);
  const expected = `### ${heading}`;
  const start = lines.findIndex((line) => line === expected);
  if (start < 0) {
    throw new Error(`${expected} section must exist`);
  }
  const next = lines.findIndex((line, index) => index > start && /^###? /.test(line));
  return lines.slice(start, next < 0 ? lines.length : next).join('\n');
}

test('deployment guide locks the bounded identity compatibility runbook', () => {
  const section = extractH2(deployGuide, 'Identity compatibility audit');
  assertInOrder(section, deployGuideRequired);

  for (const forbidden of [
    'wrangler d1',
    'SELECT',
    '--command',
    '--file',
    'actions/upload-artifact',
    '${{ secrets.CLOUDFLARE_API_TOKEN }}',
  ]) {
    assert.equal(section.includes(forbidden), false, `${forbidden} must stay out of the runbook`);
  }
  assert.doesNotMatch(
    section,
    /\b(?:dedicated-read-token|example-token|sample-token|placeholder-token|replace-with-token)\b/i,
    'the runbook must not contain an example token value',
  );
  assert.doesNotMatch(
    section,
    /\bD1_READ_TOKEN\s*=/,
    'the read token must not be assigned a literal value',
  );

  const shellFence = /```(?:bash|sh|shell)\r?\n([\s\S]*?)```/.exec(section);
  assert.ok(shellFence, 'the secret installation shell fence must exist');
  const secretInstallBlock = shellFence[1];
  const executableLines = secretInstallBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  assert.equal(executableLines[0], 'set +x');
  assertInOrder(secretInstallBlock, secretInstallLines);
  assert.deepEqual(executableLines, secretInstallLines);
  assert.doesNotMatch(secretInstallBlock, /\becho\b/);
  assert.doesNotMatch(secretInstallBlock, /gh secret set[^\n]*(?:--body(?:=|\s)|\s-b(?:=|\s))/);
});

test('implementation checklist keeps the Wave 2A production evidence unchecked', () => {
  const section = extractH2(checklist, 'Wave 2A identity compatibility gate');
  assertInOrder(section, checklistRequired);

  const checklistItems = section
    .split(/\r?\n/)
    .filter((line) => /^- \[[ xX]\]/.test(line));
  assert.ok(checklistItems.length > 0, 'Wave 2A checklist items must exist');
  assert.ok(
    checklistItems.every((line) => line.startsWith('- [ ]')),
    'Wave 2A production evidence must remain unchecked until Task 6',
  );
});

test('Wave 2A plan starts with the bounded post-review Identity contract amendment', () => {
  const heading = 'Post-review normative amendment';
  const amendment = extractH2(wave2aPlan, heading);
  const amendmentIndex = wave2aPlan.indexOf(`## ${heading}`);
  const constraintsIndex = wave2aPlan.indexOf('## Global Constraints');

  assert.ok(amendmentIndex > 0, 'the normative amendment must follow the plan preamble');
  assert.ok(
    amendmentIndex < constraintsIndex,
    'the normative amendment must be prominent and precede all implementation constraints/tasks',
  );
  assert.ok(amendment.length < 2_500, 'the amendment must stay bounded');
  assert.equal(
    wave2aPlan.match(/^## Post-review normative amendment$/gm)?.length,
    1,
    'the plan must contain exactly one normative amendment',
  );
  assertInOrder(amendment, [
    'supersedes all completed Task 1 and Task 2 prose and code snippets',
    '`test/api.integration.test.ts`',
    '`test/identity-http-contract.test.ts`',
    '`test/identity-compatibility.integration.test.ts`',
    'checked-in executable tests are authoritative',
    '`username` and `name` reject `U+0000`',
    '`U+0000` semantics for password values remain unchanged',
    'successful login and successful self-password `Set-Cookie` tokens',
    'canonical lowercase UUIDv4',
    'successful self-password change emits no replacement `Set-Cookie`',
    'presented current token remains valid',
    'sole stored D1 session',
    'sibling sessions are revoked',
  ]);
});

test('design and delivery plan fail closed when main moves around audit evidence', () => {
  const designSection = extractH3(
    designSpec,
    '10.3 Fixed read-only compatibility and hardening audits',
  );
  assertInOrder(designSection, [
    'built-in `github.token`',
    'immediately before the fixed query',
    'live remote `main`',
    '`GITHUB_SHA`',
    'immediately after the audit command',
    'Wave 2B',
    'immediately before it consumes this report',
  ]);

  const task6 = extractH3(
    wave2aPlan,
    'Task 6: Merge, deploy, and produce the Wave 2B entry evidence',
  );
  assert.ok(
    task6.includes('built-in `github.token` pre-audit and post-audit live-main guards'),
    'Task 6 must preserve both in-workflow stale-main guards',
  );
  assert.equal(
    task6.split('repos/AllStuff-agit/Here-is-order/git/ref/heads/main').length - 1,
    3,
    'Task 6 must re-read live main before dispatch, after the report, and before 2B consumes it',
  );
  assertInOrder(task6, [
    'remote_main_sha=',
    'audit_dispatch_output=',
    'audit_report_matches=',
    'remote_main_after_audit=',
    'test "$remote_main_after_audit" = "$merge_sha"',
    'Step 6: Mark the 2A gate complete and hand off to a new 2B plan',
    'wave2b_main_sha=',
    'test "$wave2b_main_sha" = "$merge_sha"',
    'before consuming the report',
  ]);
});

test('README contains only the short identity compatibility operator link', () => {
  const entries = readme
    .split(/\r?\n/)
    .filter((line) => line.includes('audit-identity-compatibility.yml'));
  assert.equal(entries.length, 1, 'README must contain one identity compatibility entry');
  assert.ok(entries[0].startsWith('- '), 'the README entry must stay a short list item');
  assert.ok(entries[0].length < 240, 'the README entry must stay short');
  assertInOrder(entries[0], readmeRequired);

  for (const field of reportFields) {
    assert.equal(readme.includes(field), false, `${field} belongs in the runbook, not README`);
  }
});
