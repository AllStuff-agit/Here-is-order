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
