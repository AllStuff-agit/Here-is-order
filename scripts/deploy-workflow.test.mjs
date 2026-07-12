import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
  new URL('../.github/workflows/deploy-worker.yml', import.meta.url),
  'utf8',
);

test('every main push deploys without a path filter or approval gate', () => {
  const pushBlock = workflow.match(/\n  push:\n([\s\S]*?)(?=\n  workflow_dispatch:)/)?.[1];
  assert.ok(pushBlock, 'push trigger must exist before workflow_dispatch');
  assert.match(pushBlock, /branches:\n\s+- main/);
  assert.doesNotMatch(pushBlock, /^\s+paths:/m);
  assert.doesNotMatch(workflow, /^\s+environment:\s+production$/m);
  assert.doesNotMatch(workflow, /PRODUCTION_API_PROXY_URL/);
});

test('official Wrangler Actions pass the API deployment URL to the web job', () => {
  const actionUses = workflow.match(/uses: cloudflare\/wrangler-action@v4\.0\.0/g) ?? [];
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

test('production jobs are ordered and smoke-tested', () => {
  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /- deploy-api/);
  assert.match(workflow, /smoke-deployment\.mjs api/);
  assert.match(workflow, /smoke-deployment\.mjs web/);
  assert.match(workflow, /cancel-in-progress: false/);
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
