import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
  new URL('../.github/workflows/deploy-worker.yml', import.meta.url),
  'utf8',
);

const CHECKOUT_ACTION =
  'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0';
const SETUP_NODE_ACTION =
  'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
const WRANGLER_ACTION =
  'cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0';

function listItemBlocks(source) {
  const lines = source.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => {
    const match = line.match(/^(\s*)-\s+/);
    return match ? [{ index, indentation: match[1].length }] : [];
  });

  return starts.map(({ index, indentation }) => {
    const end = starts.find(
      (candidate) => candidate.index > index && candidate.indentation === indentation,
    )?.index ?? lines.length;
    return lines.slice(index, end).join('\n');
  });
}

function jobBlocks(source) {
  const jobs = source.slice(source.indexOf('\njobs:\n') + 7);
  const matches = [...jobs.matchAll(/^  ([A-Za-z0-9_-]+):\n/gm)];

  return matches.map((match, index) => ({
    name: match[1],
    body: jobs.slice(
      match.index,
      matches[index + 1]?.index ?? jobs.length,
    ),
  }));
}

test('every main push deploys without a path filter or approval gate', () => {
  const pushBlock = workflow.match(/\n  push:\n([\s\S]*?)(?=\n  workflow_dispatch:)/)?.[1];
  assert.ok(pushBlock, 'push trigger must exist before workflow_dispatch');
  assert.match(pushBlock, /branches:\n\s+- main/);
  assert.doesNotMatch(pushBlock, /^\s+paths:/m);
  assert.doesNotMatch(workflow, /^\s+environment:\s+production$/m);
  assert.doesNotMatch(workflow, /PRODUCTION_API_PROXY_URL/);
});

test('official Wrangler Actions pass the API deployment URL to the web job', () => {
  const actionUses = workflow.match(
    new RegExp(`uses: ${WRANGLER_ACTION}`, 'g'),
  ) ?? [];
  assert.equal(actionUses.length, 2);
  assert.match(
    workflow,
    /api-url: \$\{\{ steps\.deploy-api\.outputs\.deployment-url \}\}/,
  );
  assert.match(
    workflow,
    /API_PROXY_URL: \$\{\{ needs\.deploy-api\.outputs\.api-url \}\}/,
  );
});

test('all delivery actions are immutable and checkout never persists credentials', () => {
  const actions = [...workflow.matchAll(/^\s+(?:-\s+)?uses:\s*([^\s#]+).*$/gm)]
    .map((match) => match[1]);
  assert.ok(actions.length > 0);
  assert.deepEqual(
    [...new Set(actions)],
    [CHECKOUT_ACTION, SETUP_NODE_ACTION, WRANGLER_ACTION],
  );
  for (const action of actions) {
    assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/);
  }

  const checkoutSteps = listItemBlocks(workflow)
    .filter((block) => block.includes(`uses: ${CHECKOUT_ACTION}`));
  assert.equal(checkoutSteps.length, 5);
  for (const checkoutStep of checkoutSteps) {
    assert.match(checkoutStep, /^\s+persist-credentials: false$/m);
  }
});

test('all delivery jobs use exact Node and finite timeouts', () => {
  const setupNodeSteps = listItemBlocks(workflow)
    .filter((block) => block.includes(`uses: ${SETUP_NODE_ACTION}`));
  assert.equal(setupNodeSteps.length, 5);
  for (const setupNodeStep of setupNodeSteps) {
    assert.match(setupNodeStep, /^\s+node-version: '22\.23\.1'$/m);
  }

  const jobs = jobBlocks(workflow);
  assert.deepEqual(jobs.map(({ name }) => name), [
    'verify',
    'd1-rest-batch-contract',
    'production-preflight',
    'deploy-api',
    'deploy-web',
  ]);
  for (const { name, body } of jobs) {
    const timeout = body.match(/^    timeout-minutes: ([1-9]\d*)$/m)?.[1];
    assert.ok(timeout, `${name} must define a finite timeout`);
    assert.ok(Number(timeout) <= 60, `${name} timeout must be at most 60 minutes`);
  }
});

test('repository runtime and package toolchain metadata are exact and consistent', async () => {
  const nodeVersion = await readFile(
    new URL('../.node-version', import.meta.url),
    'utf8',
  ).catch(() => null);
  const rootPackage = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  ));
  const frontendPackage = JSON.parse(await readFile(
    new URL('../frontend/package.json', import.meta.url),
    'utf8',
  ));

  assert.equal(nodeVersion, '22.23.1\n');
  assert.equal(rootPackage.packageManager, 'npm@10.9.8');
  assert.equal(frontendPackage.packageManager, rootPackage.packageManager);
  assert.equal(
    rootPackage.devDependencies['@cloudflare/workers-types'],
    '5.20260708.1',
  );
  assert.equal(rootPackage.devDependencies.wrangler, '4.110.0');
  assert.equal(
    frontendPackage.devDependencies.wrangler,
    rootPackage.devDependencies.wrangler,
  );
});

test('production jobs are ordered and smoke-tested', () => {
  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /- deploy-api/);
  assert.match(workflow, /smoke-deployment\.mjs api/);
  assert.match(workflow, /smoke-deployment\.mjs web/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('production preflight is the strict main-only gate before mutation', () => {
  const jobs = jobBlocks(workflow);
  const preflight = jobs.find(({ name }) => name === 'production-preflight')?.body;
  const deployApi = jobs.find(({ name }) => name === 'deploy-api')?.body;
  assert.ok(preflight, 'production-preflight job must exist');
  assert.ok(deployApi, 'deploy-api job must exist');

  assert.match(
    preflight,
    /^    if: github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\)$/m,
  );
  assert.match(
    deployApi,
    /^    if: github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\)$/m,
  );
  assert.match(preflight, /^    needs: d1-rest-batch-contract$/m);
  assert.deepEqual(
    [...preflight.matchAll(/^\s+run:\s+(.+)$/gm)].map(([, command]) => command.trim()),
    ['npm ci', 'npm run deploy:preflight'],
  );
  assert.deepEqual(
    [...preflight.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s+/gm)].map(([, name]) => name),
    ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
  );
  assert.match(
    preflight,
    /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/,
  );
  assert.match(
    preflight,
    /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/,
  );
  assert.match(
    deployApi,
    /needs:\n\s+- verify\n\s+- d1-rest-batch-contract\n\s+- production-preflight/,
  );

  const migrationCommand =
    'npm exec -- wrangler d1 migrations apply hereisorder --remote';
  assert.equal(workflow.split(migrationCommand).length - 1, 1);
  assert.ok(
    workflow.indexOf('  production-preflight:') < workflow.indexOf(migrationCommand),
    'preflight must appear before the first production migration',
  );
  for (const jobName of ['verify', 'd1-rest-batch-contract', 'production-preflight']) {
    const body = jobs.find(({ name }) => name === jobName)?.body ?? '';
    assert.doesNotMatch(body, /d1 migrations apply[^\n]*--remote/);
  }
});

test('production preflight exposes no mutation or failure bypass surface', () => {
  const jobs = jobBlocks(workflow);
  const preflight = jobs.find(({ name }) => name === 'production-preflight')?.body;
  const deployApi = jobs.find(({ name }) => name === 'deploy-api')?.body;
  assert.ok(preflight, 'production-preflight job must exist');
  assert.ok(deployApi, 'deploy-api job must exist');

  assert.doesNotMatch(workflow, /\$\{\{\s*(?:inputs|github\.event\.inputs)\./);
  assert.equal([...preflight.matchAll(/^\s+if:/gm)].length, 1);
  assert.doesNotMatch(
    `${preflight}\n${deployApi}`,
    /continue-on-error|failure\(|always\(|cancelled\(/,
  );
  assert.doesNotMatch(preflight, /\|\|\s*true|set\s+\+e/);
  assert.doesNotMatch(preflight, /^\s+(?:shell|working-directory|defaults):/m);
  assert.doesNotMatch(preflight, /^    (?:container|services|env):/m);
  assert.doesNotMatch(preflight, /--(?:config|env|remote)\b|wrangler\.toml|bookmark|\bsql\b/i);
  assert.doesNotMatch(preflight, /GITHUB_OUTPUT|upload-artifact|download-artifact/);
});

test('verify job runs web checks in CI order', () => {
  const verifyJob = workflow.match(
    /^  verify:\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:\n)/m,
  )?.[1];
  assert.ok(verifyJob, 'verify job must exist');

  const runCommands = [...verifyJob.matchAll(/^\s+run:\s+(.+)$/gm)].map(
    ([, command]) => command.trim(),
  );
  const expectedWebCommands = [
    'npm ci --prefix frontend',
    'npm run test --prefix frontend',
    'npm run lint --prefix frontend',
    'npm run build --prefix frontend',
    'npm run build:cloudflare --prefix frontend',
  ];

  assert.deepEqual(
    runCommands.filter((command) => expectedWebCommands.includes(command)),
    expectedWebCommands,
  );
});
