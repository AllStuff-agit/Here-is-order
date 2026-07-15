import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

const WORKFLOW_URL = new URL(
  '../.github/workflows/audit-identity-compatibility.yml',
  import.meta.url,
);
const PACKAGE_URL = new URL('../package.json', import.meta.url);
const CHECKOUT_ACTION = 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0';
const SETUP_NODE_ACTION = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
const PACKAGE_COMMAND = 'npm run db:audit:identity-compatibility';
const CANONICAL_WORKFLOW = [
  'name: Audit production identity compatibility',
  '',
  'on:',
  '  workflow_dispatch:',
  '',
  'permissions:',
  '  contents: read',
  '',
  'concurrency:',
  '  group: hereisorder-production-${{ github.ref }}',
  '  cancel-in-progress: false',
  '  queue: max',
  '',
  'jobs:',
  '  audit:',
  '    name: Run fixed identity compatibility audit',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 10',
  '    steps:',
  '      - name: Reject a non-main ref',
  '        if: github.ref != \'refs/heads/main\'',
  '        run: exit 1',
  '',
  '      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0',
  '        with:',
  '          persist-credentials: false',
  '',
  '      - name: Verify exact checked-out SHA',
  '        run: test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
  '',
  '      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0',
  '        with:',
  '          node-version: \'22.23.1\'',
  '          cache: \'npm\'',
  '',
  '      - name: Install dependencies',
  '        run: npm ci',
  '',
  '      - name: Audit production identity compatibility',
  '        run: npm run db:audit:identity-compatibility',
  '        env:',
  '          CI: \'true\'',
  '          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
  '          CLOUDFLARE_D1_READ_TOKEN: ${{ secrets.CLOUDFLARE_D1_READ_TOKEN }}',
].join('\n') + '\n';

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_URL, 'utf8');
}

function assertPlainMapping(value, message) {
  assert.ok(
    value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype,
    message,
  );
  return value;
}

function assertPlainYamlKeys(node) {
  if (isMap(node)) {
    for (const pair of node.items) {
      assert.ok(
        isScalar(pair.key) && pair.key.type === 'PLAIN',
        'every YAML mapping key must be a plain scalar',
      );
      assertPlainYamlKeys(pair.value);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) assertPlainYamlKeys(item);
  }
}

function countOccurrences(contents, needle) {
  return contents.split(needle).length - 1;
}

function assertIdentityCompatibilityWorkflowSafety(contents) {
  assert.equal(typeof contents, 'string', 'workflow source must be a string');

  const document = parseDocument(contents, {
    merge: false,
    schema: 'core',
    uniqueKeys: true,
  });
  assert.deepEqual(
    document.errors,
    [],
    'workflow YAML must be duplicate-key-free and parse without errors',
  );
  assert.deepEqual(document.warnings, [], 'workflow YAML must parse without warnings');
  assert.ok(isMap(document.contents), 'workflow must use a plain top-level mapping');
  assertPlainYamlKeys(document.contents);

  const workflow = assertPlainMapping(
    document.toJS({ maxAliasCount: 0 }),
    'workflow must use a plain top-level mapping',
  );
  assert.deepEqual(
    Object.keys(workflow),
    ['name', 'on', 'permissions', 'concurrency', 'jobs'],
    'top-level workflow keys must be exact and workflow env is forbidden',
  );
  assert.equal(workflow.name, 'Audit production identity compatibility');
  assert.deepEqual(
    workflow.on,
    { workflow_dispatch: null },
    'workflow_dispatch must be the only trigger and must accept no inputs',
  );
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, {
    group: 'hereisorder-production-${{ github.ref }}',
    'cancel-in-progress': false,
    queue: 'max',
  });

  const jobs = assertPlainMapping(workflow.jobs, 'jobs must contain only audit');
  assert.deepEqual(Object.keys(jobs), ['audit']);
  const audit = assertPlainMapping(jobs.audit, 'audit job must be a plain mapping');
  assert.deepEqual(
    Object.keys(audit),
    ['name', 'runs-on', 'timeout-minutes', 'steps'],
    'audit job keys must be exact and job-level if/env/outputs are forbidden',
  );
  assert.equal(audit.name, 'Run fixed identity compatibility audit');
  assert.equal(audit['runs-on'], 'ubuntu-latest');
  assert.equal(audit['timeout-minutes'], 10);
  assert.ok(Array.isArray(audit.steps));
  assert.deepEqual(audit.steps, [
    {
      name: 'Reject a non-main ref',
      if: "github.ref != 'refs/heads/main'",
      run: 'exit 1',
    },
    {
      uses: CHECKOUT_ACTION,
      with: { 'persist-credentials': false },
    },
    {
      name: 'Verify exact checked-out SHA',
      run: 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
    },
    {
      uses: SETUP_NODE_ACTION,
      with: { 'node-version': '22.23.1', cache: 'npm' },
    },
    { name: 'Install dependencies', run: 'npm ci' },
    {
      name: 'Audit production identity compatibility',
      run: PACKAGE_COMMAND,
      env: {
        CI: 'true',
        CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
        CLOUDFLARE_D1_READ_TOKEN: '${{ secrets.CLOUDFLARE_D1_READ_TOKEN }}',
      },
    },
  ]);

  const runSteps = audit.steps.filter((step) => Object.hasOwn(step, 'run'));
  assert.deepEqual(
    runSteps.map((step) => step.run),
    [
      'exit 1',
      'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
      'npm ci',
      PACKAGE_COMMAND,
    ],
    'shell commands and their order must be exact',
  );
  assert.ok(
    runSteps.every((step) => !/[\r\n]/.test(step.run)),
    'every shell command must be one line',
  );
  assert.deepEqual(
    audit.steps.filter((step) => Object.hasOwn(step, 'uses')).map((step) => step.uses),
    [CHECKOUT_ACTION, SETUP_NODE_ACTION],
    'only the two pinned actions are allowed',
  );
  assert.equal(countOccurrences(contents, PACKAGE_COMMAND), 1);
  assert.equal(countOccurrences(contents, 'git rev-parse HEAD'), 1);

  const forbiddenPatterns = [
    /CLOUDFLARE_API_TOKEN/,
    /CLOUDFLARE_FORWARD_DEPLOY_TOKEN/,
    /CLOUDFLARE_D1_READ_TOKEN\s*\|\|/,
    /\binputs\.|github\.event\.(?:inputs|client_payload)|\bINPUT_[A-Z0-9_]+/i,
    /\b(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|PRAGMA|VACUUM)\b|^\s*run:.*\bWITH\b|--(?:command|file|sql)\b/im,
    /\bwrangler(?:\s+d1)?\b/i,
    /artifact|actions\/upload-/i,
    /(?:^|\s)outputs?:|\$GITHUB_OUTPUT|::set-output/im,
    /run:\s*[|>]/,
    /continue-on-error|always\(|failure\(|\|\|\s*true|set\s+\+e/i,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(contents, pattern);
  }

  assert.equal(contents, CANONICAL_WORKFLOW, 'workflow source must be canonical');
}

test('workflow and root package command match the canonical zero-input audit contract', () => {
  const contents = readWorkflow();
  assert.equal(contents, CANONICAL_WORKFLOW);
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_URL, 'utf8'));
  assert.equal(
    packageJson.scripts['db:audit:identity-compatibility'],
    'node scripts/identity-compatibility-audit.mjs',
  );
});

test('workflow is duplicate-free, main/SHA protected, pinned, and read-token-only', () => {
  assertIdentityCompatibilityWorkflowSafety(readWorkflow());
});

test('workflow safety rejects credential, input, SQL, artifact, output, shell, and bypass mutations', () => {
  const canonical = CANONICAL_WORKFLOW;
  const mutations = [
    canonical.replace(
      '${{ secrets.CLOUDFLARE_D1_READ_TOKEN }}',
      '${{ secrets.CLOUDFLARE_D1_READ_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}',
    ),
    canonical.replace(
      'CLOUDFLARE_D1_READ_TOKEN: ${{ secrets.CLOUDFLARE_D1_READ_TOKEN }}',
      'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
    ),
    canonical.replace(
      '  workflow_dispatch:',
      '  workflow_dispatch:\n    inputs:\n      sql:\n        required: true\n        type: string',
    ),
    canonical.replace(PACKAGE_COMMAND, 'sqlite3 production.db "SELECT * FROM users"'),
    canonical.replace(PACKAGE_COMMAND, 'wrangler d1 execute hereisorder --remote'),
    canonical.replace(
      '      - name: Audit production identity compatibility',
      '      - uses: actions/upload-artifact@v4\n        with:\n          path: audit.json\n\n      - name: Audit production identity compatibility',
    ),
    canonical.replace(
      '    steps:',
      '    outputs:\n      report: ${{ steps.audit.outputs.report }}\n    steps:',
    ),
    canonical.replace(
      `        run: ${PACKAGE_COMMAND}`,
      '        run: |\n          npm run db:audit:identity-compatibility\n          echo complete',
    ),
    canonical.replace(
      `        run: ${PACKAGE_COMMAND}`,
      `        continue-on-error: true\n        run: ${PACKAGE_COMMAND}`,
    ),
    canonical.replace(
      "        if: github.ref != 'refs/heads/main'",
      '        if: always()',
    ),
    canonical.replace(
      "        if: github.ref != 'refs/heads/main'",
      '        if: failure()',
    ),
    canonical.replace(PACKAGE_COMMAND, `${PACKAGE_COMMAND} || true`),
    canonical.replace('  cancel-in-progress: false', '  cancel-in-progress: true'),
    canonical.replace(CHECKOUT_ACTION, 'actions/checkout@v7'),
    canonical.replace(
      'name: Audit production identity compatibility',
      'name: Audit production identity compatibility\nname: Duplicate',
    ),
  ];

  for (const mutation of mutations) {
    assert.notEqual(mutation, canonical, 'mutation fixture must change the workflow');
    assert.throws(() => assertIdentityCompatibilityWorkflowSafety(mutation));
  }
});
