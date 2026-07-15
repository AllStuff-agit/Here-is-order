import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const apiSpec = fs.readFileSync('docs/design/api-spec-v1.md', 'utf8');
const checklist = fs.readFileSync('docs/design/implementation-checklist-v1.md', 'utf8');

const apiHeading = 'Wave 2B implementation ownership';
const checklistHeading = 'Wave 2B identity extraction gate';

const credentialOwnership =
  'The credential runtime entry point `packages/identity-credential/src/index.mjs` and type entry point `packages/identity-credential/src/index.d.ts` own the credential format.';
const identityOwnership =
  '`src/identity/index.ts` owns the Identity/session D1 choreography.';
const honoOwnership =
  '`src/index.ts` remains the Hono adapter for current request parsing, HTTP response, and cookie mapping.';
const compatibilityRequired = [
  'Wave 2B changes implementation ownership only; it introduces no D1 schema or public runtime behavior change.',
  'Sessions continue to store the raw token in `sessions.token` with the existing 30-day lifetime.',
  'Self-password change continues to keep the current session and revoke sibling sessions.',
  'Logout continues to require an authenticated session and keeps delete plus audit in one D1 batch.',
  'Red-matrix assignments to 2C, 2D, 2E/2F-a, and 2F-b1/2F-b2 remain unchanged.',
  '2C starts only after the exact merged SHA production deploy and smoke success.',
];

const sharedRequired = [
  credentialOwnership,
  identityOwnership,
  honoOwnership,
  ...compatibilityRequired,
];

const apiOwnershipLines = [
  `### ${apiHeading}`,
  '',
  ...sharedRequired.map((line) => `- ${line}`),
  '',
];

const checklistOwnershipLines = [
  `## ${checklistHeading}`,
  '',
  `- [x] ${credentialOwnership}`,
  `- [x] ${identityOwnership}`,
  `- [x] ${honoOwnership}`,
  `- [x] ${compatibilityRequired[0]}`,
  `- [x] ${compatibilityRequired.slice(1, 5).join(' ')}`,
  '- [x] Complete repository gate passes from clean dependencies.',
  '- [ ] Wave 2B PR review and merge',
  '- [ ] Exact merged SHA production deploy',
  '- [ ] Exact merged SHA API/web/authenticated-business smoke success',
  `- [ ] ${compatibilityRequired[5]}`,
  '',
];

const forbiddenClaims = [
  /(?:sha-?256|digest(?:ed)?|다이제스트)[^\n]{0,80}(?:sessions?(?:\.token)?|세션)|(?:sessions?(?:\.token)?|세션)[^\n]{0,80}(?:sha-?256|digest(?:ed)?|다이제스트)/i,
  /(?:12[- ]?(?:character|code[ -]?point)s?|12자)/i,
  /(?:idempotent|멱등)[^\n]{0,80}logout|logout[^\n]{0,80}(?:idempotent|멱등)/i,
  /(?:token|토큰)[^\n]{0,80}(?:rotation|rotate|교체)|(?:rotation|rotate|교체)[^\n]{0,80}(?:token|토큰)/i,
  /(?:rate[- ]?limiter?|limiter bindings?|요청 제한)/i,
  /read[-_ ]?only/i,
  /migration[^\n]{0,40}003|003[^\n]{0,40}migration/i,
];

const expectedRedMatrixRows = [
  '| 없는/비활성 계정은 잘못된 비밀번호와 다른 메시지·작업량을 사용 | 모든 invalid login credential은 같은 401/message와 one-SHA/one-PBKDF2 schedule | 2C |',
  '| Identity JSON과 필드가 coercion되고 명시적 32-KiB/128/200/4096 cap이 없음 | strict content type/body/field cap, extra-field rejection, no truncation | 2C |',
  '| human password setter가 6자 minimum을 사용 | 새 human password는 12 Unicode code points 이상 | 2C |',
  '| self change가 observed hash/session expiry를 CAS하지 않고 현재 raw token을 유지 | observed-state CAS, revoke-all, same-expiry replacement token rotation | 2C |',
  '| admin reset이 target observed state를 CAS하지 않고 self reset도 허용 | target CAS, concurrent conflict, self-reset prohibition | 2C |',
  '| logout이 valid authenticated context를 요구하고 audit와 delete를 한 batch에 묶음 | public idempotent locator, authoritative delete, best-effort audit, retryable D1 failure | 2C |',
  '| presented invalid cookie 401이 항상 cookie를 clear하지 않음 | determinate invalid/expired cookie clears; D1 uncertainty does not | 2C |',
  '| 브라우저 페이지가 개별적으로 broad 401 redirect를 수행 | strict route decoder와 shared authenticated-session classifier | 2D |',
  '| reusable session token을 D1 `sessions.token`에 저장 | compatibility deployment 뒤 새 token은 SHA-256 digest만 재사용 가능 | 2E/2F-a |',
  '| production smoke identity가 일반 staff write 권한을 가짐 | additive `read_only` access mode로 모든 business mutation을 server에서 거부 | 2F-b1/2F-b2 |',
];

function assertInOrder(text, markers) {
  let previousIndex = -1;
  for (const marker of markers) {
    const index = text.indexOf(marker, previousIndex + 1);
    assert.ok(index > previousIndex, `${marker} must appear in order`);
    previousIndex = index;
  }
}

function extractSection(text, level, heading) {
  const lines = text.split(/\r?\n/);
  const prefix = '#'.repeat(level);
  const expected = `${prefix} ${heading}`;
  assert.equal(
    lines.filter((line) => line === expected).length,
    1,
    `${expected} must exist exactly once`,
  );

  const start = lines.findIndex((line) => line === expected);
  const nextHeading = new RegExp(`^#{1,${level}} `);
  const end = lines.findIndex(
    (line, index) => index > start && nextHeading.test(line),
  );
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
}

function assertBoundedOwnershipContract(section, expectedLines) {
  assert.ok(section.length < 3_000, 'the Wave 2B section must stay concise');
  assert.deepEqual(
    section.split('\n'),
    expectedLines,
    'the Wave 2B section may contain only the exact approved lines',
  );
  assertInOrder(section, sharedRequired);

  for (const forbidden of forbiddenClaims) {
    assert.doesNotMatch(
      section,
      forbidden,
      `${forbidden} must not be attributed to Wave 2B`,
    );
  }

  assert.doesNotMatch(section, /https?:\/\//i, 'run URLs must stay out of the docs');
  assert.doesNotMatch(section, /\brequest_?id\b/i, 'request IDs must stay out of the docs');
  assert.doesNotMatch(section, /\bisorder_sid=/i, 'cookie values must stay out of the docs');
  assert.doesNotMatch(section, /\braw audit\b/i, 'raw audit output must stay out of the docs');
  assert.doesNotMatch(
    section,
    /["'](?:id|username|name|role|actor_user_id|user_id|session_id)["']\s*:/i,
    'user and audit JSON fields must stay out of the docs',
  );
  assert.doesNotMatch(section, /\{[^}\n]*["'][^}\n]*\}/, 'inline JSON evidence must stay out of the docs');
  assert.doesNotMatch(
    section,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    'identity data must stay out of the docs',
  );
  assert.doesNotMatch(section, /\b[0-9a-f]{40}\b/i, 'commit values must stay out of the docs');
  assert.doesNotMatch(section, /\b[0-9a-f]{64}\b/i, 'hash values must stay out of the docs');
  assert.doesNotMatch(
    section,
    /\b(?:account|database|worker)[-_ ]?(?:id|uuid)\b/i,
    'production identifiers must stay out of the docs',
  );
  assert.doesNotMatch(section, /```/, 'raw logs and evidence blocks must stay out of the docs');
}

function assertRedMatrixContract(text) {
  const section = extractSection(text, 3, 'Wave 2 전환 red matrix');
  const rows = section
    .split(/\r?\n/)
    .filter((line) => line.startsWith('| '))
    .slice(2);
  assert.deepEqual(rows, expectedRedMatrixRows);
}

test('credential ownership points to the checked-in runtime and type entry points', () => {
  assert.equal(fs.existsSync('packages/identity-credential/src/index.mjs'), true);
  assert.equal(fs.existsSync('packages/identity-credential/src/index.d.ts'), true);
  assert.equal(fs.existsSync('packages/identity-credential/src/index.ts'), false);
});

test('API spec records the bounded Wave 2B implementation ownership', () => {
  assert.match(
    apiSpec,
    /^\uAD6C\uD604 \uAE30\uC900: Hono HTTP adapter[^\n]*`src\/index\.ts`[^\n]*`src\/identity\/index\.ts`[^\n]*`packages\/identity-credential\/src\/index\.mjs`[^\n]*`packages\/identity-credential\/src\/index\.d\.ts`$/m,
  );

  const section = extractSection(apiSpec, 3, apiHeading);
  assertBoundedOwnershipContract(section, apiOwnershipLines);
  assertRedMatrixContract(apiSpec);
});

test('implementation checklist separates completed repository evidence from production evidence', () => {
  const section = extractSection(checklist, 2, checklistHeading);
  assertBoundedOwnershipContract(section, checklistOwnershipLines);

  const checkedItems = section
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- [x]'));
  const pendingItems = section
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- [ ]'));

  assert.equal(checkedItems.length, 6, 'exactly six repository facts must be complete');
  assert.equal(pendingItems.length, 4, 'exactly four production facts must remain pending');
  assertInOrder(section, [
    `- [x] ${credentialOwnership}`,
    `- [x] ${identityOwnership}`,
    `- [x] ${honoOwnership}`,
    `- [x] ${compatibilityRequired[0]}`,
    `- [x] ${compatibilityRequired[1]}`,
    '- [x] Complete repository gate',
    '- [ ] Wave 2B PR review and merge',
    '- [ ] Exact merged SHA production deploy',
    '- [ ] Exact merged SHA API/web/authenticated-business smoke success',
    `- [ ] ${compatibilityRequired[5]}`,
  ]);
});

test('bounded ownership contract rejects later-slice claims and evidence leakage', () => {
  const validSection = apiOwnershipLines.join('\n');
  assert.doesNotThrow(() =>
    assertBoundedOwnershipContract(validSection, apiOwnershipLines),
  );

  for (const claim of [
    'Wave 2B stores SHA-256 hashes in sessions.',
    'Wave 2B enforces 12-character passwords in HTTP requests.',
    'Wave 2B makes logout idempotent.',
    'Wave 2B adds token rotation.',
    'Wave 2B adds limiter bindings.',
    'Wave 2B adds read-only access.',
    'Wave 2B applies migration 003.',
  ]) {
    assert.throws(() =>
      assertBoundedOwnershipContract(`${validSection}${claim}\n`, apiOwnershipLines),
    );
  }

  for (const paraphrase of [
    'Wave 2B stores hashed session tokens.',
    'Wave 2B changes the HTTP password minimum to twelve characters.',
    'Wave 2B allows repeated logout requests to succeed.',
    'Wave 2B issues a replacement session token after password change.',
    'Wave 2B applies 003_identity.sql.',
    'Audit record: action=login actor_user_id=42',
    'Account: 0123456789abcdef0123456789abcdef',
  ]) {
    assert.throws(() =>
      assertBoundedOwnershipContract(`${validSection}${paraphrase}\n`, apiOwnershipLines),
    );
  }

  for (const evidence of [
    'Raw audit: {"action":"login","actor_user_id":42}',
    'User data: {"username":"admin"}',
    'Commit: 0123456789abcdef0123456789abcdef01234567',
    'Hash: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ]) {
    assert.throws(() =>
      assertBoundedOwnershipContract(`${validSection}${evidence}\n`, apiOwnershipLines),
    );
  }
});

test('compatibility assertions and later-slice matrix assignments fail closed', () => {
  const validSection = apiOwnershipLines.join('\n');
  const opposites = [
    [
      compatibilityRequired[1],
      'Sessions no longer store the raw token in `sessions.token`; the 30-day lifetime was removed.',
    ],
    [
      compatibilityRequired[2],
      'Self-password change revokes the current session and keeps sibling sessions.',
    ],
    [
      compatibilityRequired[3],
      'Logout no longer requires an authenticated session or uses a D1 batch.',
    ],
  ];

  for (const [current, opposite] of opposites) {
    const mutated = validSection.replace(current, opposite);
    assert.notEqual(mutated, validSection);
    assert.throws(() => assertBoundedOwnershipContract(mutated, apiOwnershipLines));
  }

  const reassigned = apiSpec.replace(
    '| strict route decoder와 shared authenticated-session classifier | 2D |',
    '| strict route decoder와 shared authenticated-session classifier | 2B |',
  );
  assert.notEqual(reassigned, apiSpec);
  assert.throws(() => assertRedMatrixContract(reassigned));
});
