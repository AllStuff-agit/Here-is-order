import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const WORKFLOW_URL = new URL(
  '../.github/workflows/audit-order-item-integrity.yml',
  import.meta.url,
);
const CHECKOUT_ACTION =
  'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0';
const SETUP_NODE_ACTION =
  'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
const CANONICAL_WORKFLOW = [
  'name: Audit production order item integrity',
  'run-name: Audit production order item integrity / ${{ inputs.request_id }}',
  '',
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      request_id:',
  '        description: Unique non-sensitive correlation ID',
  '        required: true',
  '        type: string',
  '',
  'permissions:',
  '  contents: read',
  '',
  'concurrency:',
  '  group: production-order-item-integrity-audit',
  '  cancel-in-progress: false',
  '',
  'jobs:',
  '  audit:',
  '    name: Run read-only production summary',
  '    if: github.ref == \'refs/heads/main\'',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 10',
  '    steps:',
  '      - name: Checkout',
  '        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0',
  '        with:',
  '          persist-credentials: false',
  '',
  '      - name: Set up Node.js',
  '        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0',
  '        with:',
  '          node-version: \'22\'',
  '          cache: \'npm\'',
  '',
  '      - name: Install dependencies',
  '        run: npm ci',
  '',
  '      - name: Audit production Order Item integrity',
  '        run: npm run db:audit:order-items -- --remote --summary',
  '        env:',
  '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_D1_READ_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}',
  '          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
].join('\n') + '\n';

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_URL, 'utf8');
}

function leadingSpaces(line) {
  return line.match(/^ */)[0].length;
}

function indentedBlock(source, header) {
  const lines = source.split(/\r?\n/);
  const start = lines.indexOf(header);
  assert.notEqual(start, -1, `${header} block이 필요합니다.`);
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

test('workflow 전체는 canonical safety contract와 정확히 일치한다', () => {
  assert.equal(readWorkflow(), CANONICAL_WORKFLOW);
});

test('workflow는 required request_id가 있는 manual main-only audit이다', () => {
  const workflow = readWorkflow();
  const dispatchBlock = indentedBlock(workflow, '  workflow_dispatch:');
  const inputsBlock = indentedBlock(workflow, '    inputs:');
  const requestIdBlock = indentedBlock(workflow, '      request_id:').join('\n');

  assert.deepEqual(directKeys(indentedBlock(workflow, 'on:'), 2), ['workflow_dispatch']);
  assert.deepEqual(directKeys(dispatchBlock, 4), ['inputs']);
  assert.deepEqual(directKeys(inputsBlock, 6), ['request_id']);
  assert.match(requestIdBlock, /^        required: true$/m);
  assert.match(requestIdBlock, /^        type: string$/m);
  assert.match(
    workflow,
    /^run-name: Audit production order item integrity \/ \$\{\{ inputs\.request_id \}\}$/m,
  );
  assert.deepEqual(directKeys(indentedBlock(workflow, 'jobs:'), 2), ['audit']);
  assert.match(workflow, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(workflow, /^    timeout-minutes: 10$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^concurrency:\n  group: production-order-item-integrity-audit\n  cancel-in-progress: false$/m);
});

test('workflow는 pinned action과 exact summary command 및 허용된 secret만 사용한다', () => {
  const workflow = readWorkflow();
  const actions = [...workflow.matchAll(/^\s+(?:-\s+)?uses:\s*([^\s#]+).*$/gm)]
    .map((match) => match[1]);
  const commands = [...workflow.matchAll(/^\s+run:\s*(\S.*)$/gm)]
    .map((match) => match[1].trim());
  const secrets = [...new Set(
    [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]),
  )].sort();

  assert.deepEqual(actions, [CHECKOUT_ACTION, SETUP_NODE_ACTION]);
  assert.deepEqual(commands, [
    'npm ci',
    'npm run db:audit:order-items -- --remote --summary',
  ]);
  assert.match(workflow, /^          persist-credentials: false$/m);
  assert.match(
    workflow,
    /^          CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_D1_READ_TOKEN \|\| secrets\.CLOUDFLARE_API_TOKEN \}\}$/m,
  );
  assert.match(
    workflow,
    /^          CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}$/m,
  );
  assert.deepEqual(secrets, [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_D1_READ_TOKEN',
  ]);
});

test('workflow는 details, artifact, mutation 우회 및 output channel을 포함하지 않는다', () => {
  const workflow = readWorkflow();
  const forbidden = [
    ['details mode', /--details\b/i],
    ['output option', /--output\b/i],
    ['artifact', /\bartifact\b/i],
    ['continue-on-error', /^\s*continue-on-error:/mi],
    ['direct Wrangler', /\bwrangler\b/i],
    ['job or step outputs', /^\s*outputs:/mi],
    ['GITHUB_OUTPUT', /GITHUB_OUTPUT/i],
    ['deprecated set-output', /set-output/i],
    ['multiline run', /^\s*run:\s*[|>]/mi],
  ];

  for (const [name, pattern] of forbidden) {
    assert.doesNotMatch(workflow, pattern, `${name}은 사용할 수 없습니다.`);
  }
});
