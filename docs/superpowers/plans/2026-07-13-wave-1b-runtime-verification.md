# Wave 1B Runtime Verification Implementation Plan

> Execute task-by-task with test-driven development. Do not create or modify a production user in this plan.

**Goal:** Prove that the deployed API can use the required production D1 schema and that both Worker URLs are served by the exact Git commit which deployment intended.

**Architecture:** A Worker-side readiness Module owns one compile-only D1 schema probe and a small safe HTTP projection. A Node post-deploy Module owns fixed API/web targets, Wrangler deploy NDJSON parsing, Cloudflare REST comparison, exact version-message validation, bounded retry, verified URL handoff, and one whitelist report. The workflow deploys with the pinned local Wrangler and verifies active versions before public smoke. Authenticated smoke identity provisioning remains a separate production mutation unit.

**Tech stack:** TypeScript, Hono, Cloudflare D1, Vitest/Miniflare, Node.js test runner, Wrangler 4.110.0, GitHub Actions, Cloudflare Workers Deployments/Versions APIs.

**Safety constraints:**

- No production row creation, update, delete, export, or artifact.
- Readiness SQL is fixed and returns no production row.
- No arbitrary Worker, config, URL, version, SQL, or annotation input.
- No raw exception, Cloudflare envelope, author, credential, binding, business row, or cookie in evidence.
- No automatic rollback or D1 restore.
- Active version verification must pass before URL smoke.

---

### Task 1: Commit the reviewed Wave 1B-R boundary

**Files:**

- Add: `docs/superpowers/specs/2026-07-13-wave-1b-runtime-verification-design.md`
- Add: `docs/superpowers/plans/2026-07-13-wave-1b-runtime-verification.md`

**Verification:**

```bash
git diff --check
rg -n "Wave 1B-R|GET /ready|workers/message|production row" \
  docs/superpowers/specs/2026-07-13-wave-1b-runtime-verification-design.md \
  docs/superpowers/plans/2026-07-13-wave-1b-runtime-verification.md
```

**Commit:** `docs: design runtime deployment verification`

---

### Task 2: Add D1 required-schema readiness

**Files:**

- Add: `src/readiness.ts`
- Add: `test/readiness.integration.test.ts`
- Modify: `src/index.ts`

**RED tests:**

- fixed SQL references every current required table/column and contains no mutation keyword;
- healthy migrated Miniflare D1 returns the exact safe probe projection;
- `GET /ready` returns exact 200 envelope and `Cache-Control: no-store`;
- missing binding, thrown query, empty/multiple/malformed result all return the same exact 503;
- thrown sensitive detail is absent from response and log;
- `/health` remains independent and 200.

**Implementation:**

- implement `d1-required-schema-v1` compile-only probe;
- validate exact single result without exposing row data;
- add public `GET /ready` route with safe event log and no-store response.

**Verification:**

```bash
npm exec -- vitest run test/readiness.integration.test.ts
npm run typecheck
```

**Commit:** `feat: verify required D1 schema readiness`

---

### Task 3: Require readiness in deployment smoke

**Files:**

- Modify: `scripts/smoke-deployment.mjs`
- Modify: `scripts/smoke-deployment.test.mjs`

**RED tests:**

- API smoke checks `/health` then `/ready` on the same origin;
- readiness requires exact 200 success envelope and schema version;
- 503, malformed JSON/envelope, wrong version, redirect, or thrown transport fails;
- retry restarts the health/readiness pair without logging response data.

**Implementation:** extend only API smoke; keep web smoke behavior unchanged.

**Verification:**

```bash
node --test scripts/smoke-deployment.test.mjs
```

**Commit:** `test: gate API smoke on D1 readiness`

---

### Task 4: Enable safe API observability

**Files:**

- Add: `src/observability.ts`
- Add: `test/observability.test.ts`
- Modify: `src/index.ts`
- Modify: `wrangler.toml`
- Modify: `scripts/deploy-workflow.test.mjs`

**RED tests:**

- root config explicitly enables persisted invocation logs at rate 1;
- safe logger accepts only the three fixed event names and serializes no supplied exception;
- global request and session-cleanup errors do not log raw sensitive detail;
- no trace setting is introduced in this unit.

**Implementation:** replace raw `console.error(error)` calls with the fixed event logger and add exact observability config.

**Verification:**

```bash
npm exec -- vitest run test/observability.test.ts test/readiness.integration.test.ts
npm run build
```

**Commit:** `feat: enable safe API runtime logs`

---

### Task 5: Implement expected active version verifier

**Files:**

- Add: `scripts/verify-worker-deployment.mjs`
- Add: `scripts/verify-worker-deployment.test.mjs`
- Modify: `package.json`

**RED tests:**

- only fixed `api`/`web` targets map to exact Worker name/config/working directory;
- NDJSON accepts exactly one successful Wrangler 4.110.0 deploy session with exact `deploy --message <SHA> --strict` args;
- deploy evidence requires the fixed Worker name, one UUID version ID, and one clean HTTPS origin;
- REST active deployment must allocate 100% to the NDJSON version ID and carry the exact release message;
- exact REST version must have `workers/message === GITHUB_SHA`;
- environment is exact main push/dispatch CI metadata with credentials and summary path;
- malformed/split/stale/mismatched responses, annotation, HTTP/JSON/transport errors fail closed;
- bounded retry emits no intermediate raw evidence;
- report and summary use only the documented whitelist and are immutable;
- summary failure cannot leave a success log.

**Implementation:** parse only whitelist deploy evidence, reuse the existing strict active-deployment projection where possible, and add only exact deployment-message/version reads and comparison policy.

**Verification:**

```bash
node --test scripts/verify-worker-deployment.test.mjs scripts/production-preflight.test.mjs
```

**Commit:** `feat: verify expected active Worker versions`

---

### Task 6: Gate smoke on exact active versions

**Files:**

- Modify: `.github/workflows/deploy-worker.yml`
- Modify: `scripts/deploy-workflow.test.mjs`
- Modify: `README.md`
- Modify: `docs/design/cloudflare-deploy-guide.md`
- Modify: `scripts/delivery-recovery-docs.test.mjs`

**RED tests:**

- API/web use the lockfile-pinned local Wrangler instead of an Action and include exact `$GITHUB_SHA` message plus `--strict`;
- each deploy writes a fixed runner-temp NDJSON file which its verifier alone consumes;
- API/web active-version verification immediately follows its deploy and precedes smoke;
- verifier receives only fixed target plus credentials scoped to that step;
- no failure bypass, arbitrary input, shell interpolation, raw JSON artifact, or status output logging;
- the API URL job output comes only from verified deploy evidence;
- recovery phase table distinguishes version-verified and D1-ready states.

**Implementation:** add post-deploy steps, preserve API → web ordering and existing deployment URL handoff, and update the runbook.

**Verification:**

```bash
node --test scripts/deploy-workflow.test.mjs scripts/delivery-recovery-docs.test.mjs
```

**Commit:** `ci: gate smoke on active Worker versions`

---

### Task 7: Full verification, independent review, and delivery

**Local gate:**

```bash
npm test
npm run typecheck
npm run build
npm ci --prefix frontend
npm run test --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
npm run build:cloudflare --prefix frontend
git diff --check
git status --short
```

Then request an independent review focused on data exposure, fail-open workflow paths, parser ambiguity, readiness false positives, and regression risk. Address findings, rerun the full gate, publish a PR, wait for required checks, merge, and verify the exact merge SHA production run.

Production evidence must show:

- API active version report matches the merge SHA;
- API `/health` and D1-backed `/ready` pass;
- web active version report matches the merge SHA;
- existing web login/proxy smoke passes;
- no production identity was created or modified by this unit.

Wave 1 remains open for the separately approved authenticated smoke identity unit.
