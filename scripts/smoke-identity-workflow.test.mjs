import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const lifecycle = fs.readFileSync('.github/workflows/manage-smoke-identity.yml', 'utf8');
const deploy = fs.readFileSync('.github/workflows/deploy-worker.yml', 'utf8');

test('lifecycle and deployment share non-cancelling repository/ref concurrency', () => {
  for (const workflow of [lifecycle, deploy]) {
    assert.match(workflow, /concurrency:\n  group: hereisorder-production-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false/);
  }
});

test('manual workflow is main-only with fixed choice and static action commands', () => {
  assert.match(lifecycle, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(lifecycle, /^  (?:push|pull_request):/m);
  assert.match(lifecycle, /type: choice\n        options:\n          - provision\n          - rotate\n          - disable/);
  assert.match(
    lifecycle,
    /- name: Reject a non-main ref\n        if: github\.ref != 'refs\/heads\/main'\n        run: exit 1/,
  );
  assert.doesNotMatch(lifecycle, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  const refGuard = lifecycle.indexOf('- name: Reject a non-main ref');
  assert.ok(refGuard < lifecycle.indexOf('- uses: actions/checkout@'));
  assert.ok(refGuard < lifecycle.indexOf('secrets.CLOUDFLARE_API_TOKEN'));
  for (const action of ['provision', 'rotate', 'disable']) {
    assert.match(lifecycle, new RegExp(`run: npm run db:manage-smoke-identity -- ${action} --remote`));
  }
  assert.doesNotMatch(lifecycle, /run:.*\$\{\{.*inputs/);
  assert.match(
    lifecycle,
    /if: inputs\.action != 'provision' && inputs\.action != 'rotate' && inputs\.action != 'disable'\n        run: exit 1/,
  );
  assert.doesNotMatch(lifecycle, /continue-on-error|always\(|failure\(|\|\|\s*true|set\s+\+e/);
});

test('password is scoped only to provision and rotate static steps', () => {
  const occurrences = lifecycle.match(/PRODUCTION_SMOKE_PASSWORD: \$\{\{ secrets\.PRODUCTION_SMOKE_PASSWORD \}\}/g) ?? [];
  assert.equal(occurrences.length, 2);
  const disableBlock = lifecycle.slice(lifecycle.indexOf('- name: Disable'), lifecycle.length);
  assert.doesNotMatch(disableBlock, /PRODUCTION_SMOKE_PASSWORD/);
  assert.doesNotMatch(lifecycle, /^env:/m);
  assert.doesNotMatch(lifecycle, /^    env:/m);
});
