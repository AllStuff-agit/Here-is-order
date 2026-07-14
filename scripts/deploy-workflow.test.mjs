import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseDocument } from 'yaml';

const workflow = await readFile(
  new URL('../.github/workflows/deploy-worker.yml', import.meta.url),
  'utf8',
);

const CHECKOUT_ACTION =
  'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0';
const SETUP_NODE_ACTION =
  'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
const AUTHENTICATED_SMOKE_SECRET =
  '${{ secrets.PRODUCTION_SMOKE_PASSWORD }}';
const AUTHENTICATED_SMOKE_FORBIDDEN =
  /cloudflare_|username|cookie|continue-on-error|always\(|failure\(|cancelled\(|\|\|\s*true|set\s+\+e|upload-artifact|download-artifact|artifact/i;
const DEPLOY_WEB_JOB_HEADER = [
  '  deploy-web:',
  '    name: Deploy web Worker',
  "    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
  '    needs:',
  '      - verify',
  '      - deploy-api',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 20',
].join('\n');

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

function parseWorkflow(source) {
  const document = parseDocument(source, {
    merge: false,
    schema: 'core',
    uniqueKeys: true,
  });
  assert.deepEqual(
    document.errors,
    [],
    'deployment workflow YAML must be duplicate-key-free and parse without errors',
  );
  assert.deepEqual(
    document.warnings,
    [],
    'deployment workflow YAML must parse without warnings',
  );
  return assertPlainMapping(
    document.toJS({ maxAliasCount: 0 }),
    'deployment workflow must use a plain top-level mapping',
  );
}

function assertAuthenticatedDeployWebGate(source) {
  const parsed = parseWorkflow(source);
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed, 'env')
      || Object.prototype.hasOwnProperty.call(parsed, 'defaults'),
    false,
    'deployment workflow top-level env and defaults are forbidden',
  );
  const jobs = assertPlainMapping(parsed.jobs, 'deployment jobs must be a mapping');
  const web = assertPlainMapping(
    jobs['deploy-web'],
    'deploy-web job must be a mapping',
  );
  assert.equal(
    web.if,
    "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    'deploy-web must retain the exact main push and dispatch condition',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(web, 'env'),
    false,
    'deploy-web must not define job-level env',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(web, 'continue-on-error'),
    false,
    'deploy-web must not define job-level continue-on-error',
  );
  assert.deepEqual(
    Object.keys(web),
    ['name', 'if', 'needs', 'runs-on', 'timeout-minutes', 'steps'],
    'deploy-web job must have the exact execution contract',
  );
  assert.deepEqual(
    {
      name: web.name,
      if: web.if,
      needs: web.needs,
      'runs-on': web['runs-on'],
      'timeout-minutes': web['timeout-minutes'],
    },
    {
      name: 'Deploy web Worker',
      if: "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
      needs: ['verify', 'deploy-api'],
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 20,
    },
    'deploy-web job must have the exact execution contract',
  );
  assert.ok(Array.isArray(web.steps), 'deploy-web steps must be a sequence');

  const steps = web.steps;
  assert.deepEqual(
    steps.map((step) => step.name ?? step.uses),
    [
      CHECKOUT_ACTION,
      SETUP_NODE_ACTION,
      'Install deployment dependencies',
      'Install dependencies',
      'Build production web Worker',
      'Deploy web Worker',
      'Verify web active Worker version',
      'Smoke test web deployment and API proxy',
      'Smoke test authenticated business flow',
    ],
    'deploy-web steps must preserve the exact deployment and smoke order',
  );

  assert.deepEqual(
    steps[1],
    {
      uses: SETUP_NODE_ACTION,
      with: {
        'node-version': '22.23.1',
        cache: 'npm',
        'cache-dependency-path': 'package-lock.json\nfrontend/package-lock.json\n',
      },
    },
    'deploy-web setup-node must cache both root and frontend lockfiles',
  );

  const runCommands = steps
    .filter((step) => Object.prototype.hasOwnProperty.call(step, 'run'))
    .map((step) => step.run);
  assert.deepEqual(
    runCommands,
    [
      'npm ci',
      'npm ci --prefix frontend',
      'npm run build:cloudflare --prefix frontend',
      'npm exec -- opennextjs-cloudflare deploy --message "$GITHUB_SHA" --strict',
      'node scripts/verify-worker-deployment.mjs web',
      'node scripts/smoke-deployment.mjs web "$DEPLOYMENT_URL"',
      'node scripts/authenticated-business-smoke.mjs',
    ],
    'deploy-web commands must use the exact install, deploy, verify, and smoke order',
  );
  assert.equal(
    runCommands.filter((command) => command === 'npm ci').length,
    1,
    'deploy-web must install root dependencies exactly once',
  );
  assert.equal(
    runCommands.filter((command) => command === 'npm ci --prefix frontend').length,
    1,
    'deploy-web must install frontend dependencies exactly once',
  );

  assert.deepEqual(
    steps[6],
    {
      name: 'Verify web active Worker version',
      id: 'verify-web',
      run: 'node scripts/verify-worker-deployment.mjs web',
      env: {
        CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
        CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
        WRANGLER_OUTPUT_FILE_PATH: '${{ runner.temp }}/hereisorder-web-deploy.ndjson',
      },
    },
    'verify-web step must be exact',
  );
  assert.deepEqual(
    steps[7],
    {
      name: 'Smoke test web deployment and API proxy',
      env: {
        DEPLOYMENT_URL: '${{ steps.verify-web.outputs.deployment-url }}',
      },
      run: 'node scripts/smoke-deployment.mjs web "$DEPLOYMENT_URL"',
    },
    'public web smoke step must be exact',
  );
  const authenticated = steps.at(-1);
  assert.doesNotMatch(
    JSON.stringify(authenticated),
    AUTHENTICATED_SMOKE_FORBIDDEN,
    'authenticated smoke must expose no credential, identity, cookie, artifact, or failure-bypass surface',
  );
  assert.deepEqual(
    authenticated,
    {
      name: 'Smoke test authenticated business flow',
      env: {
        DEPLOYMENT_URL: '${{ steps.verify-web.outputs.deployment-url }}',
        PRODUCTION_SMOKE_PASSWORD: AUTHENTICATED_SMOKE_SECRET,
      },
      run: 'node scripts/authenticated-business-smoke.mjs',
    },
    'authenticated smoke must be the exact required final step',
  );
  assert.equal(
    source.split('secrets.PRODUCTION_SMOKE_PASSWORD').length - 1,
    1,
    'deployment workflow must reference the production smoke password exactly once',
  );
}

test('every main push deploys without a path filter or approval gate', () => {
  const pushBlock = workflow.match(/\n  push:\n([\s\S]*?)(?=\n  workflow_dispatch:)/)?.[1];
  assert.ok(pushBlock, 'push trigger must exist before workflow_dispatch');
  assert.match(pushBlock, /branches:\n\s+- main/);
  assert.doesNotMatch(pushBlock, /^\s+paths:/m);
  assert.doesNotMatch(workflow, /^\s+environment:\s+production$/m);
  assert.doesNotMatch(workflow, /PRODUCTION_API_PROXY_URL/);
});

test('verified Wrangler evidence is the only API deployment URL source', () => {
  assert.doesNotMatch(workflow, /cloudflare\/wrangler-action/);
  assert.match(
    workflow,
    /api-url: \$\{\{ steps\.verify-api\.outputs\.deployment-url \}\}/,
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
    [CHECKOUT_ACTION, SETUP_NODE_ACTION],
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

test('API and web deploy with exact SHA evidence before active-version verification and smoke', () => {
  const jobs = jobBlocks(workflow);
  const api = jobs.find(({ name }) => name === 'deploy-api')?.body ?? '';
  const web = jobs.find(({ name }) => name === 'deploy-web')?.body ?? '';

  const expected = [
    {
      body: api,
      target: 'api',
      deployName: 'Deploy API Worker',
      verifyName: 'Verify API active Worker version',
      smokeName: 'Smoke test API deployment',
      evidencePath: '${{ runner.temp }}/hereisorder-api-deploy.ndjson',
      deployCommand: 'npm exec -- wrangler deploy --message "$GITHUB_SHA" --strict',
    },
    {
      body: web,
      target: 'web',
      deployName: 'Deploy web Worker',
      verifyName: 'Verify web active Worker version',
      smokeName: 'Smoke test web deployment and API proxy',
      evidencePath: '${{ runner.temp }}/hereisorder-web-deploy.ndjson',
      deployCommand: 'npm exec -- opennextjs-cloudflare deploy --message "$GITHUB_SHA" --strict',
    },
  ];

  for (const scenario of expected) {
    const deploy = listItemBlocks(scenario.body)
      .find((block) => block.includes(`name: ${scenario.deployName}`)) ?? '';
    const verify = listItemBlocks(scenario.body)
      .find((block) => block.includes(`name: ${scenario.verifyName}`)) ?? '';
    const smoke = listItemBlocks(scenario.body)
      .find((block) => block.includes(`name: ${scenario.smokeName}`)) ?? '';

    assert.ok(deploy, `${scenario.target} deploy step must exist`);
    assert.ok(verify, `${scenario.target} verification step must exist`);
    assert.ok(smoke, `${scenario.target} smoke step must exist`);
    assert.match(
      deploy,
      new RegExp(`^\\s+run: ${scenario.deployCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
    );
    assert.match(
      deploy,
      new RegExp(`^\\s+WRANGLER_OUTPUT_FILE_PATH: ${scenario.evidencePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
    );
    assert.match(deploy, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
    assert.match(deploy, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
    assert.match(verify, new RegExp(`^\\s+run: node scripts/verify-worker-deployment\\.mjs ${scenario.target}$`, 'm'));
    assert.match(verify, new RegExp(`^\\s+id: verify-${scenario.target}$`, 'm'));
    assert.match(verify, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
    assert.match(verify, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
    assert.match(
      verify,
      new RegExp(`^\\s+WRANGLER_OUTPUT_FILE_PATH: ${scenario.evidencePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
    );

    assert.ok(scenario.body.indexOf(scenario.deployName) < scenario.body.indexOf(scenario.verifyName));
    assert.ok(scenario.body.indexOf(scenario.verifyName) < scenario.body.indexOf(scenario.smokeName));
    assert.doesNotMatch(`${deploy}\n${verify}\n${smoke}`, /continue-on-error|always\(|failure\(|\|\|\s*true|set\s+\+e/);
  }

  assert.match(api, /DEPLOYMENT_URL: \$\{\{ steps\.verify-api\.outputs\.deployment-url \}\}/);
  assert.match(web, /DEPLOYMENT_URL: \$\{\{ steps\.verify-web\.outputs\.deployment-url \}\}/);
  assert.match(web, /^\s+working-directory: frontend$/m);
  assert.doesNotMatch(api, /^\s+working-directory:/m);
  assert.doesNotMatch(web, /^\s+run: npm exec -- wrangler deploy --message "\$GITHUB_SHA" --strict$/m);
  assert.doesNotMatch(workflow, /command-output|deployments status --json|upload-artifact|download-artifact/);
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

test('deploy-web structurally requires locked installs and authenticated smoke as the final gate', () => {
  assertAuthenticatedDeployWebGate(workflow);
});

const dangerousDeployWebMutations = [
  {
    name: 'replaces public proxy smoke execution with a no-op shell',
    expected: /public web smoke step must be exact/,
    mutate(source) {
      return source.replace(
        '      - name: Smoke test web deployment and API proxy\n        env:',
        '      - name: Smoke test web deployment and API proxy\n        shell: bash -c \'exit 0\' -- {0}\n        env:',
      );
    },
  },
  {
    name: 'replaces verifier execution with an output-forging shell',
    expected: /verify-web step must be exact/,
    mutate(source) {
      return source.replace(
        '        id: verify-web\n        run: node scripts/verify-worker-deployment.mjs web',
        '        id: verify-web\n        shell: bash -c \'echo "deployment-url=https://hereisorder-web.attacker.workers.dev" >> "$GITHUB_OUTPUT"\' -- {0}\n        run: node scripts/verify-worker-deployment.mjs web',
      );
    },
  },
  {
    name: 'adds a deploy-web default shell that bypasses failures',
    expected: /deploy-web job must have the exact execution contract/,
    mutate(source) {
      return source.replace(
        `${DEPLOY_WEB_JOB_HEADER}\n    steps:`,
        `${DEPLOY_WEB_JOB_HEADER}\n    defaults:\n      run:\n        shell: bash -e {0} || true\n    steps:`,
      );
    },
  },
  {
    name: 'adds quoted top-level Cloudflare credential environment',
    expected: /deployment workflow top-level env and defaults are forbidden/,
    mutate(source) {
      return source.replace(
        'permissions:\n  contents: read\n\nconcurrency:',
        'permissions:\n  contents: read\n\n"env":\n  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n\nconcurrency:',
      );
    },
  },
  {
    name: 'adds deploy-web container environment inheritance',
    expected: /deploy-web job must have the exact execution contract/,
    mutate(source) {
      return source.replace(
        `${DEPLOY_WEB_JOB_HEADER}\n    steps:`,
        `${DEPLOY_WEB_JOB_HEADER}\n    container:\n      image: node:22\n      env:\n        CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:`,
      );
    },
  },
  {
    name: 'adds a strategy matrix that duplicates deployment',
    expected: /deploy-web job must have the exact execution contract/,
    mutate(source) {
      return source.replace(
        `${DEPLOY_WEB_JOB_HEADER}\n    steps:`,
        `${DEPLOY_WEB_JOB_HEADER}\n    strategy:\n      matrix:\n        replica: [one, two]\n    steps:`,
      );
    },
  },
  {
    name: 'adds quoted top-level failure-bypassing defaults',
    expected: /deployment workflow top-level env and defaults are forbidden/,
    mutate(source) {
      return source.replace(
        'permissions:\n  contents: read\n\nconcurrency:',
        'permissions:\n  contents: read\n\n"defaults":\n  run:\n    shell: bash -e {0} || true\n\nconcurrency:',
      );
    },
  },
  {
    name: 'replaces the deploy-web main-only condition with quoted false',
    expected: /deploy-web must retain the exact main push and dispatch condition/,
    mutate(source) {
      return source.replace(
        "  deploy-web:\n    name: Deploy web Worker\n    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
        '  deploy-web:\n    name: Deploy web Worker\n    "if": false',
      );
    },
  },
  {
    name: 'adds a quoted false condition to authenticated smoke',
    expected: /authenticated smoke must be the exact required final step/,
    mutate(source) {
      return source.replace(
        '      - name: Smoke test authenticated business flow\n        env:',
        '      - name: Smoke test authenticated business flow\n        "if": false\n        env:',
      );
    },
  },
  {
    name: 'adds a quoted job-level environment',
    expected: /deploy-web must not define job-level env/,
    mutate(source) {
      return source.replace(
        '  deploy-web:\n    name: Deploy web Worker\n',
        '  deploy-web:\n    name: Deploy web Worker\n    "env":\n      LEAK: enabled\n',
      );
    },
  },
  {
    name: 'adds job-level continue-on-error',
    expected: /deploy-web must not define job-level continue-on-error/,
    mutate(source) {
      return source.replace(
        '  deploy-web:\n    name: Deploy web Worker\n',
        '  deploy-web:\n    name: Deploy web Worker\n    "continue-on-error": true\n',
      );
    },
  },
  {
    name: 'adds mixed-case Cloudflare credentials to authenticated smoke',
    expected: /authenticated smoke must expose no credential, identity, cookie, artifact, or failure-bypass surface/,
    mutate(source) {
      return source.replace(
        '          PRODUCTION_SMOKE_PASSWORD: ${{ secrets.PRODUCTION_SMOKE_PASSWORD }}\n',
        '          PRODUCTION_SMOKE_PASSWORD: ${{ secrets.PRODUCTION_SMOKE_PASSWORD }}\n          ClOuDfLaRe_ApI_ToKeN: forbidden\n',
      );
    },
  },
];

test('semantic deploy-web gate rejects dangerous YAML mutations', async (t) => {
  for (const { name, expected, mutate } of dangerousDeployWebMutations) {
    await t.test(name, () => {
      const mutated = mutate(workflow);
      assert.notEqual(mutated, workflow, 'mutation fixture must change the workflow');
      const document = parseDocument(mutated, {
        merge: false,
        schema: 'core',
        uniqueKeys: true,
      });
      assert.deepEqual(document.errors, [], 'mutation fixture must be valid YAML');
      assert.throws(() => assertAuthenticatedDeployWebGate(mutated), expected);
    });
  }
});
