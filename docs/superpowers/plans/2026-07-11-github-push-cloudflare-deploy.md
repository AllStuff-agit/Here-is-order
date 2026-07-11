# GitHub Push Cloudflare Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every push to `main` automatically verify the repository, migrate production D1, deploy the API Worker, pass its deployment URL to the OpenNext web build, deploy the web Worker, and smoke-test both deployments.

**Architecture:** A single GitHub Actions workflow owns the ordered pipeline `verify → deploy-api → deploy-web`. Cloudflare's official Wrangler Action exposes each public deployment URL, while a small Node.js smoke-test CLI validates HTTPS origins and checks the API, login page, and same-origin API proxy.

**Tech Stack:** GitHub Actions, Node.js 22, Node built-in test runner, Cloudflare Wrangler 4, `cloudflare/wrangler-action@v4.0.0`, D1 migrations, Next.js 16, OpenNext Cloudflare.

## Global Constraints

- Every `main` push deploys production without path filters, manual variables, environment approvals, or button presses.
- Pull requests run verification only; `workflow_dispatch` remains an optional recovery trigger.
- Production jobs consume only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Production order is D1 migration, API deploy, API health check, web build/deploy, web and proxy smoke check.
- `cancel-in-progress: false` must serialize pushes rather than interrupt migrations or deployments.
- Do not alter the password-recovery instructions excluded by the user.
- Do not discard or overwrite existing worktree changes; they are the approved 1–5 and 7 implementation.

---

### Task 1: Checkpoint the Existing Verified Implementation

**Files:**
- Commit: all currently modified and untracked project files except generated build directories ignored by Git
- Preserve: `README.md` password-recovery section verbatim

**Interfaces:**
- Consumes: the already verified roles, atomic D1 operations, bootstrap, OpenNext configuration, tests, CI draft, and documentation
- Produces: a clean baseline commit on local `main` before the automatic deployment delta

- [ ] **Step 1: Re-run the existing quality gate**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run web:lint
npm run web:build
API_PROXY_URL=https://api.example.com npm run build:cloudflare --prefix frontend
npm audit --omit=dev
npm audit --omit=dev --prefix frontend
git diff --check
```

Expected: 15 tests pass, both audits report 0 vulnerabilities, and every command exits 0.

- [ ] **Step 2: Confirm the commit scope**

Run:

```bash
git status --short
git diff --stat
```

Expected: only the approved inventory/API/bootstrap/deployment/docs changes are listed; no `.env`, `.dev.vars`, token, `.next/`, or `.open-next/` files are present.

- [ ] **Step 3: Commit the approved baseline**

```bash
git add -A
git commit -m "feat: harden inventory and cloudflare deployment"
```

Expected: a commit is created and `git status --short` is empty.

---

### Task 2: Add a Deterministic Deployment Smoke-Test CLI

**Files:**
- Create: `scripts/smoke-deployment.mjs`
- Create: `scripts/smoke-deployment.test.mjs`

**Interfaces:**
- Produces: `validateDeploymentOrigin(value): URL`
- Produces: `smokeApi(origin, options?): Promise<void>`
- Produces: `smokeWeb(origin, options?): Promise<void>`
- CLI: `node scripts/smoke-deployment.mjs <api|web> <https-origin>`

- [ ] **Step 1: Write the failing smoke-test unit tests**

Create `scripts/smoke-deployment.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  smokeApi,
  smokeWeb,
  validateDeploymentOrigin,
} from './smoke-deployment.mjs';

test('validateDeploymentOrigin accepts only a clean HTTPS origin', () => {
  assert.equal(validateDeploymentOrigin('https://api.example.com').origin, 'https://api.example.com');
  assert.throws(() => validateDeploymentOrigin('http://api.example.com'), /HTTPS/);
  assert.throws(() => validateDeploymentOrigin('https://user:pass@api.example.com'), /credentials/);
  assert.throws(() => validateDeploymentOrigin('https://api.example.com/path'), /origin/);
  assert.throws(() => validateDeploymentOrigin('https://api.example.com/?query=1'), /query|hash/);
});

test('smokeApi checks the public health response contract', async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    paths.push(url.pathname);
    return new Response(JSON.stringify({ ok: true, data: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await smokeApi('https://api.example.com', {
    attempts: 1,
    delayMs: 0,
    fetchImpl,
  });

  assert.deepEqual(paths, ['/health']);
});

test('smokeWeb checks the login page and unauthenticated API proxy', async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    paths.push(url.pathname);
    if (url.pathname === '/login') {
      return new Response('<!doctype html>', { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  };

  await smokeWeb('https://web.example.com', {
    attempts: 1,
    delayMs: 0,
    fetchImpl,
  });

  assert.deepEqual(paths, ['/login', '/api/users/me']);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
node --test scripts/smoke-deployment.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/smoke-deployment.mjs`.

- [ ] **Step 3: Implement the smoke-test CLI**

Create `scripts/smoke-deployment.mjs`:

```js
import { pathToFileURL } from 'node:url';

const DEFAULT_ATTEMPTS = 10;
const DEFAULT_DELAY_MS = 3_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function validateDeploymentOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Deployment URL is required.');
  }

  const url = new URL(value.trim());
  if (url.protocol !== 'https:') {
    throw new Error('Deployment URL must use HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Deployment URL must not include credentials.');
  }
  if (url.pathname !== '/') {
    throw new Error('Deployment URL must be an origin without a path.');
  }
  if (url.search || url.hash) {
    throw new Error('Deployment URL must not include a query string or hash.');
  }

  return url;
}

async function retry(check, options) {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

export async function smokeApi(origin, options = {}) {
  const baseUrl = validateDeploymentOrigin(origin);
  const fetchImpl = options.fetchImpl ?? fetch;

  await retry(async () => {
    const response = await fetchImpl(new URL('/health', baseUrl), { redirect: 'manual' });
    if (response.status !== 200) {
      throw new Error(`API health returned HTTP ${response.status}.`);
    }

    const body = await response.json();
    if (body?.ok !== true || body?.data?.ok !== true) {
      throw new Error('API health returned an unexpected response.');
    }
  }, options);
}

export async function smokeWeb(origin, options = {}) {
  const baseUrl = validateDeploymentOrigin(origin);
  const fetchImpl = options.fetchImpl ?? fetch;

  await retry(async () => {
    const loginResponse = await fetchImpl(new URL('/login', baseUrl), { redirect: 'manual' });
    if (loginResponse.status !== 200) {
      throw new Error(`Web login returned HTTP ${loginResponse.status}.`);
    }

    const proxyResponse = await fetchImpl(new URL('/api/users/me', baseUrl), { redirect: 'manual' });
    if (proxyResponse.status !== 401) {
      throw new Error(`Web API proxy returned HTTP ${proxyResponse.status}; expected 401.`);
    }
  }, options);
}

async function main() {
  const [target, origin] = process.argv.slice(2);
  if (target === 'api') {
    await smokeApi(origin);
  } else if (target === 'web') {
    await smokeWeb(origin);
  } else {
    throw new Error('Usage: node scripts/smoke-deployment.mjs <api|web> <https-origin>');
  }

  console.log(`${target} deployment smoke test passed: ${validateDeploymentOrigin(origin).origin}`);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run the unit tests and root test suite**

Run:

```bash
node --test scripts/smoke-deployment.test.mjs
npm test
```

Expected: the three smoke tests pass and the complete root suite passes.

- [ ] **Step 5: Commit the smoke-test unit**

```bash
git add scripts/smoke-deployment.mjs scripts/smoke-deployment.test.mjs
git commit -m "test: add cloudflare deployment smoke checks"
```

---

### Task 3: Replace the Draft Workflow with Push-Only Automatic Deployment

**Files:**
- Create: `scripts/deploy-workflow.test.mjs`
- Modify: `.github/workflows/deploy-worker.yml`

**Interfaces:**
- Consumes: `node scripts/smoke-deployment.mjs <api|web> <origin>`
- Produces: deploy-api job output `api-url`, sourced from `steps.deploy-api.outputs.deployment-url`
- Consumes in deploy-web: `needs.deploy-api.outputs.api-url` as server-only `API_PROXY_URL`

- [ ] **Step 1: Write a failing workflow contract test**

Create `scripts/deploy-workflow.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run:

```bash
node --test scripts/deploy-workflow.test.mjs
```

Expected: FAIL because the draft workflow still has push path filters, `environment: production`, a manual `PRODUCTION_API_PROXY_URL`, and no Wrangler Action deployment outputs.

- [ ] **Step 3: Replace the workflow**

Replace `.github/workflows/deploy-worker.yml` with:

```yaml
name: Verify and deploy

on:
  pull_request:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false

jobs:
  verify:
    name: Verify API, migrations, and web
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7.0.0

      - uses: actions/setup-node@v6.4.0
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: |
            package-lock.json
            frontend/package-lock.json

      - name: Install API dependencies
        run: npm ci

      - name: Type-check API
        run: npm run typecheck

      - name: Test API and deployment contracts
        run: npm test

      - name: Validate Worker bundle
        run: npm run build

      - name: Validate D1 migrations locally
        run: npm exec -- wrangler d1 migrations apply hereisorder --local --persist-to /tmp/hereisorder-ci

      - name: Install web dependencies
        run: npm ci --prefix frontend

      - name: Lint web
        run: npm run lint --prefix frontend

      - name: Build web
        run: npm run build --prefix frontend

      - name: Validate Cloudflare web bundle
        run: npm run build:cloudflare --prefix frontend

  deploy-api:
    name: Deploy API Worker
    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
    needs: verify
    runs-on: ubuntu-latest
    outputs:
      api-url: ${{ steps.deploy-api.outputs.deployment-url }}
    steps:
      - uses: actions/checkout@v7.0.0

      - uses: actions/setup-node@v6.4.0
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Apply production D1 migrations
        run: npm exec -- wrangler d1 migrations apply hereisorder --remote
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Deploy API Worker
        id: deploy-api
        uses: cloudflare/wrangler-action@v4.0.0
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
          packageManager: npm

      - name: Smoke test API deployment
        env:
          DEPLOYMENT_URL: ${{ steps.deploy-api.outputs.deployment-url }}
        run: node scripts/smoke-deployment.mjs api "$DEPLOYMENT_URL"

      - name: Record API deployment
        env:
          DEPLOYMENT_URL: ${{ steps.deploy-api.outputs.deployment-url }}
        run: |
          echo "### API Worker" >> "$GITHUB_STEP_SUMMARY"
          echo "$DEPLOYMENT_URL" >> "$GITHUB_STEP_SUMMARY"

  deploy-web:
    name: Deploy web Worker
    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
    needs:
      - verify
      - deploy-api
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7.0.0

      - uses: actions/setup-node@v6.4.0
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: frontend/package-lock.json

      - name: Install dependencies
        run: npm ci --prefix frontend

      - name: Build production web Worker
        run: npm run build:cloudflare --prefix frontend
        env:
          API_PROXY_URL: ${{ needs.deploy-api.outputs.api-url }}

      - name: Deploy web Worker
        id: deploy-web
        uses: cloudflare/wrangler-action@v4.0.0
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
          workingDirectory: frontend
          packageManager: npm

      - name: Smoke test web deployment and API proxy
        env:
          DEPLOYMENT_URL: ${{ steps.deploy-web.outputs.deployment-url }}
        run: node scripts/smoke-deployment.mjs web "$DEPLOYMENT_URL"

      - name: Record web deployment
        env:
          DEPLOYMENT_URL: ${{ steps.deploy-web.outputs.deployment-url }}
        run: |
          echo "### Web Worker" >> "$GITHUB_STEP_SUMMARY"
          echo "$DEPLOYMENT_URL" >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 4: Run contract, YAML, and dry-run validation**

Run:

```bash
node --test scripts/deploy-workflow.test.mjs
node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/deploy-worker.yml', 'utf8')); console.log('YAML OK')"
npm run build
API_PROXY_URL=https://api.example.com npm run build:cloudflare --prefix frontend
(cd frontend && npm exec -- wrangler deploy --dry-run)
```

Expected: contract tests pass, `YAML OK` is printed, and all Worker builds/dry-runs exit 0. If `yaml` is not resolvable from the installed dependency graph, use Ruby's standard YAML parser solely for the syntax check:

```bash
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/deploy-worker.yml', aliases: true); puts 'YAML OK'"
```

- [ ] **Step 5: Commit the automatic deployment workflow**

```bash
git add .github/workflows/deploy-worker.yml scripts/deploy-workflow.test.mjs
git commit -m "ci: deploy cloudflare on every main push"
```

---

### Task 4: Synchronize Operator Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/design/cloudflare-deploy-guide.md`
- Modify: `docs/design/implementation-checklist-v1.md`

**Interfaces:**
- Documents: `git push origin main` is the normal production deployment interface
- Documents: only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are required
- Removes: `PRODUCTION_API_PROXY_URL` setup instructions

- [ ] **Step 1: Update the README deployment section**

Use this production flow as the primary instruction:

```markdown
## Cloudflare 자동 배포

GitHub Actions에 `CLOUDFLARE_API_TOKEN`과 `CLOUDFLARE_ACCOUNT_ID` repository secret을 한 번 등록한 뒤에는 `main` push만으로 배포됩니다.

```bash
git push origin main
```

Workflow는 검증 → production D1 migration → API Worker 배포/health check → API URL을 주입한 웹 Worker 배포 → 웹/API proxy smoke test 순서로 실행됩니다. 별도 `PRODUCTION_API_PROXY_URL` 변수나 GitHub Environment 승인은 필요하지 않습니다.
```

Keep the existing manual Wrangler commands below it under a `수동 복구 배포` heading, and do not change the password-recovery section.

- [ ] **Step 2: Update the deployment guide**

Replace the GitHub setup table with:

```markdown
| 종류 | 이름 | 값 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Workers 배포와 D1 migration 권한을 가진 API token |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 대상 Cloudflare account ID |

`main`의 모든 push가 production 배포를 시작합니다. API Worker의 실제 URL은 Wrangler Action의 `deployment-url` output으로 웹 job에 전달되므로 `PRODUCTION_API_PROXY_URL` 변수는 설정하지 않습니다.
```

Document the two smoke checks exactly: API `GET /health` must return 200 and web `GET /api/users/me` without a session must return 401.

- [ ] **Step 3: Update the implementation checklist**

Replace the manual variable item with checked implementation items:

```markdown
- [x] `main`의 모든 push에서 production 자동 배포
- [x] Wrangler Action 배포 URL을 웹 `API_PROXY_URL`로 자동 전달
- [x] API health 및 웹 same-origin proxy smoke test
- [x] 별도 production URL 변수와 Environment 승인 불필요
```

- [ ] **Step 4: Verify documentation consistency**

Run:

```bash
rg -n "PRODUCTION_API_PROXY_URL|environment: production" README.md docs .github/workflows
git diff --check
```

Expected: no active setup instruction requires either string. Historical design context may mention that the variable was intentionally removed.

- [ ] **Step 5: Commit the documentation**

```bash
git add README.md docs/design/cloudflare-deploy-guide.md docs/design/implementation-checklist-v1.md
git commit -m "docs: explain push-only cloudflare deployment"
```

---

### Task 5: Verify, Push Main, and Monitor the Real Deployment

**Files:**
- Verify: entire repository
- Publish: local `main` to `origin/main`
- Observe: GitHub Actions workflow `Verify and deploy`

**Interfaces:**
- Trigger: `git push origin main`
- Success evidence: GitHub run conclusion `success`, API URL, web URL, and successful smoke steps

- [ ] **Step 1: Run the final local quality gate**

Run:

```bash
npm test
npm run typecheck
npm run build
npm exec -- wrangler d1 migrations apply hereisorder --local --persist-to /tmp/hereisorder-final
npm run web:lint
npm run web:build
API_PROXY_URL=https://api.example.com npm run build:cloudflare --prefix frontend
(cd frontend && npm exec -- wrangler deploy --dry-run)
npm audit --omit=dev
npm audit --omit=dev --prefix frontend
git diff --check
git status -sb
```

Expected: all commands exit 0 and local `main` is ahead of `origin/main` with a clean worktree.

- [ ] **Step 2: Push once to trigger production**

```bash
git push origin main
```

Expected: the remote `main` advances to the local HEAD and one push-triggered `Verify and deploy` run starts.

- [ ] **Step 3: Watch the workflow to completion**

```bash
RUN_ID="$(gh run list --workflow "Verify and deploy" --branch main --event push --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
```

Expected: Verify, Deploy API Worker, and Deploy web Worker all conclude `success`.

- [ ] **Step 4: Inspect deployment evidence**

```bash
RUN_ID="$(gh run list --workflow "Verify and deploy" --branch main --event push --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run view "$RUN_ID" --json conclusion,jobs,url,headSha
gh run view "$RUN_ID" --log | rg "deployment smoke test passed|workers.dev"
```

Expected: the run head SHA equals local `HEAD`, both deployment URLs are present, and both smoke-test messages are logged.

- [ ] **Step 5: Handle a real deployment failure without stopping early**

If the run fails, inspect only the failed logs:

```bash
RUN_ID="$(gh run list --workflow "Verify and deploy" --branch main --event push --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run view "$RUN_ID" --log-failed
```

Fix the concrete cause locally, rerun the relevant local gate, commit with a scoped `fix:` message, push `main` again, and watch the new run. Do not claim completion until a push-triggered run succeeds or an external permission/secret blocker is proven.
