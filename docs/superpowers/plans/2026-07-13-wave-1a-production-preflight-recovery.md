# Wave 1A Production Preflight and Recovery Evidence Implementation Plan

> Execute this plan task-by-task with test-driven development. Keep production mutations behind the preflight job and never run a D1 restore from CI.

**Goal:** Make every production deployment reproducible and recovery-ready by capturing a strict D1 checkpoint, migration manifest, and current API/web Worker versions before the first production mutation.

**Architecture:** A deep `production-preflight` Node module owns the fixed production target, Cloudflare response validation, migration-prefix invariant, report whitelist, and one authoritative GitHub job-summary adapter. It reuses the existing D1 REST client for exact-name/query operations, adds only the Time Travel bookmark operation there, and keeps Worker deployment reads inside the preflight adapter. GitHub Actions gates migration on this report and uses immutable external Action/runtime references. Recovery remains an explicit operator decision documented by phase.

**Tech stack:** Node.js 22.23.1, npm 10.9.8, Wrangler 4.110.0, GitHub Actions, Cloudflare D1 Time Travel API, Cloudflare Workers Deployments API, Node test runner.

**Safety constraints:**

- No production row export or artifact.
- No arbitrary database, Worker, SQL, URL, or bookmark workflow input.
- No automatic Worker rollback or D1 restore.
- No raw Cloudflare error envelope, token, author email, or production row in logs.
- Preflight must complete before `wrangler d1 migrations apply --remote` can run.
- Applied production migrations must be an exact prefix of repository migrations.
- Keep pull requests verification-only and preserve current main push/dispatch deployment behavior.

---

### Task 1: Commit the reviewed Wave 1 design

**Files:**

- Add: `docs/superpowers/specs/2026-07-13-wave-1-delivery-recovery-guardrail-design.md`
- Add: `docs/superpowers/plans/2026-07-13-wave-1a-production-preflight-recovery.md`

**Step 1: Review the design against the approved portfolio**

Confirm:

- Wave 2 remains blocked until all of Wave 1B passes production verification;
- existing split Worker deployments fail closed rather than choosing an ambiguous rollback target;
- D1 restore and Worker rollback are never automatic;
- production rows and credentials never become CI evidence.

**Step 2: Verify documentation formatting and links**

```bash
git diff --check
rg -n "Time Travel|rollback|forward repair|Wave 1B" \
  docs/superpowers/specs/2026-07-13-wave-1-delivery-recovery-guardrail-design.md \
  docs/superpowers/plans/2026-07-13-wave-1a-production-preflight-recovery.md
```

**Step 3: Commit the design**

```bash
git add docs/superpowers/specs/2026-07-13-wave-1-delivery-recovery-guardrail-design.md \
  docs/superpowers/plans/2026-07-13-wave-1a-production-preflight-recovery.md
git commit -m "docs: design production delivery guardrails"
```

---

### Task 2: Pin the complete delivery toolchain

**Files:**

- Add: `.node-version`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `frontend/package.json`
- Modify: `.github/workflows/deploy-worker.yml`
- Modify: `.github/workflows/audit-order-item-integrity.yml`
- Modify: `scripts/deploy-workflow.test.mjs`
- Modify: `scripts/audit-order-item-integrity-workflow.test.mjs`

**Step 1: Add failing immutable toolchain assertions**

Extend the workflow tests to require:

- every `uses:` reference in both workflows is a 40-character lowercase commit SHA;
- every checkout sets `persist-credentials: false`;
- every setup-node uses `22.23.1`;
- `.node-version`, root/frontend `packageManager`, and root/frontend Wrangler versions are exact and consistent.

```bash
node --test scripts/deploy-workflow.test.mjs scripts/audit-order-item-integrity-workflow.test.mjs
```

Expected: FAIL against the current mutable Action tags and runtime selectors.

**Step 2: Add exact shared runtime metadata**

- `.node-version`: `22.23.1`
- root and frontend `packageManager`: `npm@10.9.8`
- root Wrangler: exact `4.110.0`, matching frontend
- regenerate only the root lockfile through an exact npm install

Run:

```bash
npm install --save-dev --save-exact wrangler@4.110.0
git add package.json package-lock.json
```

**Step 3: Replace every external Action tag with a reviewed full SHA**

Use comments to retain the human release:

- `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0`
- `actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0`
- `cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0 # v4.0.0`

Set every checkout to `persist-credentials: false`, every setup-node to `22.23.1`, and finite job timeouts. Preserve least-privilege `contents: read`.

**Step 4: Verify the deterministic workflow contract**

```bash
node --test scripts/deploy-workflow.test.mjs scripts/audit-order-item-integrity-workflow.test.mjs
npm ci --ignore-scripts=false
git diff --exit-code -- package.json package-lock.json
npm exec -- wrangler --version
npm exec --prefix frontend -- wrangler --version
```

Expected: both Wrangler commands return `4.110.0`; lockfile remains unchanged after `npm ci`.

**Step 5: Commit**

```bash
git add .node-version package.json package-lock.json frontend/package.json \
  .github/workflows/deploy-worker.yml .github/workflows/audit-order-item-integrity.yml \
  scripts/deploy-workflow.test.mjs scripts/audit-order-item-integrity-workflow.test.mjs
git commit -m "ci: pin production delivery toolchain"
```

---

### Task 3: Add strict Time Travel bookmark support to the D1 adapter

**Files:**

- Modify: `scripts/cloudflare-d1-rest.mjs`
- Modify: `scripts/cloudflare-d1-rest.test.mjs`

**Step 1: Write failing adapter tests**

Require `getTimeTravelBookmark(databaseId)` to:

- call only `GET /accounts/{account}/d1/database/{uuid}/time_travel/bookmark`;
- require HTTP success and Cloudflare `success: true`;
- require an object result with exactly one safe opaque `bookmark` string;
- reject missing/empty/oversized/control-character bookmarks and extra result fields;
- expose only generic sanitized failures.

Run:

```bash
node --test scripts/cloudflare-d1-rest.test.mjs
```

Expected: FAIL because the adapter method is absent.

**Step 2: Implement the minimum adapter method**

Reuse `databaseResourcePath()` and the private request envelope. Do not add restore support in this task.

**Step 3: Verify and commit**

```bash
node --test scripts/cloudflare-d1-rest.test.mjs
git add scripts/cloudflare-d1-rest.mjs scripts/cloudflare-d1-rest.test.mjs
git commit -m "feat: read strict D1 recovery bookmarks"
```

---

### Task 4: Implement the production preflight deep module

**Files:**

- Add: `scripts/production-preflight.mjs`
- Add: `scripts/production-preflight.test.mjs`
- Modify: `package.json`

**Step 1: Write failing pure policy tests**

Require:

- valid applied migrations are an exact local prefix and return pending names;
- unknown, reordered, duplicated, non-contiguous, or malformed applied migrations fail;
- `applied_at` accepts D1's real UTC `YYYY-MM-DD HH:MM:SS` format and rejects malformed values;
- strict D1 identity requires one exact name and configured UUID;
- bookmark, git SHA, run ID/attempt, deployment/version UUID, timestamp, and 100% single-version deployment are validated;
- empty/split deployment state fails closed;
- the report has only the documented whitelist.

```bash
node --test scripts/production-preflight.test.mjs
```

Expected: FAIL because `scripts/production-preflight.mjs` does not exist.

**Step 2: Implement pure policy**

Export and test small policy seams:

- `readMigrationManifest()`
- `parseAppliedMigrationResult()`
- `findPendingMigrations()`
- `parseActiveDeployment()`
- `buildPreflightReport()`

The module owns fixed names `hereisorder` and `hereisorder-web`. Worker deployment fetches use encoded fixed script names, sort valid entries by `created_on` descending, and validate the latest active deployment as one UUID version at 100% traffic. Empty/malformed deployment lists and split allocations fail closed. The report retains the selected deployment ID and complete one-entry traffic allocation. Ignore and never log author email.

**Step 3: Implement orchestration with injected adapters**

`runProductionPreflight()` must perform, in order:

1. validate exact main ref, git SHA, run ID, and run attempt;
2. read the single `DB` binding from `wrangler.toml`;
3. require one Cloudflare D1 with the same name and UUID;
4. retrieve the current bookmark;
5. query only `SELECT id, name, applied_at FROM d1_migrations ORDER BY id`;
6. compare production applied migrations to the repository manifest;
7. read API and web active deployments;
8. build one whitelisted report;
9. append the complete safe report to the single authoritative `GITHUB_STEP_SUMMARY` sink only after every validation passes;
10. emit the same whitelisted JSON to the job log only after the summary append succeeds.

Any failure must produce a generic error and no ready report/output.

**Step 4: Add end-to-end fake adapter tests**

Test success order and the following stop conditions:

- missing credentials or non-main ref;
- config/API database mismatch;
- malformed bookmark;
- migration divergence;
- API deployment malformed;
- web deployment malformed;
- summary writer failure never prints or records a ready result.

Also assert token, author email, arbitrary row fields, and raw error bodies never appear in output.

**Step 5: Add the fixed npm command and verify**

```json
"deploy:preflight": "node scripts/production-preflight.mjs"
```

```bash
node --test scripts/production-preflight.test.mjs scripts/cloudflare-d1-rest.test.mjs
```

**Step 6: Commit**

```bash
git add scripts/production-preflight.mjs scripts/production-preflight.test.mjs package.json
git commit -m "feat: verify production deployment checkpoint"
```

---

### Task 5: Gate production mutation on preflight evidence

**Files:**

- Modify: `.github/workflows/deploy-worker.yml`
- Modify: `scripts/deploy-workflow.test.mjs`
- Modify: `scripts/d1-rest-batch-contract.test.mjs`

**Step 1: Write failing production gate and bypass tests**

Require:

- `production-preflight` needs the disposable rollback contract;
- `deploy-api` needs `production-preflight`;
- preflight appears before the first production migration command;
- preflight has no workflow target/bookmark/SQL input;
- production migration is absent from verify/contract/preflight jobs;
- preflight has no `continue-on-error`, failure-tolerating expression, custom shell, container, service, or alternate config override.

```bash
node --test scripts/deploy-workflow.test.mjs scripts/d1-rest-batch-contract.test.mjs
```

Expected: FAIL because the preflight job is absent.

**Step 2: Add `production-preflight` after the remote contract**

The job must be main push/dispatch only, need `d1-rest-batch-contract`, install exact root dependencies, and run:

```bash
npm run deploy:preflight
```

with only the existing Cloudflare credentials and GitHub immutable run metadata.

**Step 3: Rewire the mutation gate**

`deploy-api` needs `production-preflight`. The migration step remains the first production mutation. Preserve API → web ordering and current deployment URL handoff.

**Step 4: Verify all static workflow safety contracts**

Run:

```bash
node --test scripts/deploy-workflow.test.mjs scripts/d1-rest-batch-contract.test.mjs
```

**Step 5: Commit**

```bash
git add .github/workflows/deploy-worker.yml scripts/deploy-workflow.test.mjs \
  scripts/d1-rest-batch-contract.test.mjs
git commit -m "ci: gate production changes on checkpoint"
```

---

### Task 6: Make recovery decisions executable

**Files:**

- Modify: `docs/design/cloudflare-deploy-guide.md`
- Modify: `README.md`
- Add: `scripts/delivery-recovery-docs.test.mjs`

**Step 1: Write failing documentation contract tests**

Require the runbook to contain:

- the exact preflight → migration → API → web order;
- where to find the D1 bookmark and previous API/web deployment IDs plus complete traffic allocations;
- exact `wrangler deployments status` and version-specific `wrangler rollback` commands;
- forward repair as the default after migration;
- a warning that Worker rollback never restores D1;
- the Time Travel bookmark validity window (Free 7 days, Paid 30 days);
- current bookmark capture before any separately approved D1 restore;
- no automatic restore/rollback language and no credential values.

Run:

```bash
node --test scripts/delivery-recovery-docs.test.mjs
```

Expected: FAIL until the runbook is complete.

**Step 2: Write the phase table and commands**

Document failure handling for `verified`, `remote_contract_verified`, `checkpointed`, `migrated`, `api_deployed`, `api_health_smoked`, `web_deployed`, and `web_proxy_smoked`.

The D1 restore section must be explicitly exceptional and destructive. It requires separate approval, the run's exact bookmark, and a fresh current bookmark that can undo the restore.

**Step 3: Verify and commit**

```bash
node --test scripts/delivery-recovery-docs.test.mjs scripts/password-recovery-docs.test.mjs
git add docs/design/cloudflare-deploy-guide.md README.md scripts/delivery-recovery-docs.test.mjs
git commit -m "docs: add phase-based deployment recovery"
```

---

### Task 7: Full verification, review, merge, and production evidence

**Step 1: Install clean worktree dependencies**

```bash
npm ci
npm ci --prefix frontend
```

**Step 2: Run the complete local gate**

```bash
npm test
npm run typecheck
npm run build
npm run test --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
npm run build:cloudflare --prefix frontend
git diff --check main...HEAD
```

Expected: every command passes; no generated artifact is staged.

**Step 3: Request spec and code/security review**

Review must specifically verify:

- strict report/Cloudflare envelope whitelists;
- fixed target and fixed migration SQL;
- no production mutation before preflight;
- secret/redaction behavior;
- Action SHA provenance;
- no automatic restore or rollback.

**Step 4: Publish through a pull request**

Use a conventional commit/PR summary including test evidence, no schema change, and the new Cloudflare permissions required only if current token cannot read Worker deployments or Time Travel bookmarks.

**Step 5: Correlate the exact merged SHA**

Monitor only the main `Verify and deploy` run whose `headSha` equals the merge commit. Require success for verify, remote contract, production preflight, API deploy, and web deploy.

**Step 6: Inspect only whitelisted production evidence**

Record:

- run URL and exact merge SHA;
- preflight version and execution time;
- D1 name/UUID/bookmark;
- applied/pending migration names;
- previous API/web deployment IDs and complete traffic allocations;
- API/web deployment URLs and smoke conclusions.

Do not expose token, raw Cloudflare envelopes, author email, or production rows.

**Step 7: Run independent API/web smoke and mark Wave 1A complete**

Wave 1B remains the next priority until D1 readiness, authenticated business smoke, API observability, and active version verification are deployed.
