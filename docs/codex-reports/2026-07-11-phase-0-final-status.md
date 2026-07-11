# Phase 0 Hardening — Final Status for GPT App

Date: 2026-07-10 UTC
Repository: `69755354/newme-platform`
Branch: `work`
Pull Request: https://github.com/69755354/newme-platform/pull/2
PR number: `#2`
Base / head: `main` → `work`
Remote head SHA: `7c62991e6e07ece4264c71e43d7312d2c8b1de76`

## A. GO / NO-GO

**NO-GO for merge.**

Reason: `npm run lint` is a confirmed `BASELINE_FAILURE` with existing lint debt (`19428 problems: 1709 errors, 17719 warnings`). The Phase 0 additions themselves passed their deterministic checks, but the repository should not be merged under a green-gate policy until the lint baseline is resolved or formally scoped.

## B. PR URL

https://github.com/69755354/newme-platform/pull/2

## C. PR number

`#2`

## D. Base / head

- Base: `main` (`0ba0224c63a9257103e2a153377b22903e6706bd`)
- Head: `work` (`7c62991e6e07ece4264c71e43d7312d2c8b1de76`)

## E. Remote HEAD SHA

`7c62991e6e07ece4264c71e43d7312d2c8b1de76`

## F. Commits in PR

- `a2e6b03` `[CODEX][task_production_readiness] add crm ci and close taskboard blockers`
- `4a3fc88` `chore: verify git push access`
- `bae3802` `docs: restore codex engineering audit reports`
- `8ada9ce` `security: enforce Supabase server boundaries`
- `6584109` `security: add IDOR ownership matrix and regression tests`
- `32eb61a` `test: add repository-owned regression foundation`
- `b997670` `test: add database regression harness`
- `7611012` `ci: add repository validation workflow`
- `a0024f7` `ops: remove PM2 production ambiguity`
- `7c62991` `ci: use safe Supabase placeholders for build`

## G. Changed files

See PR files tab. Key additions:

- `.github/workflows/ci.yml`
- `.github/workflows/crm-ci.yml`
- `docs/codex-reports/2026-07-11-*.md`
- `docs/security/phase-0-risk-register.md`
- `docs/security/idor-ownership-matrix.md`
- `docs/database/regression-harness.md`
- `docs/ops/systemd-only.md`
- `scripts/check-supabase-boundaries.mjs`
- `scripts/supabase-boundary-allowlist.json`
- `scripts/check-db-static.mjs`
- `tests/unit/stage-guard.test.mjs`
- `tests/security/idor-static.test.mjs`
- `tests/integration/api-validation-static.test.mjs`
- `tests/regression/db-static.test.mjs`
- `src/lib/supabase-admin.ts`

## H. Completed tasks

1. Restored and re-verified seven engineering audit reports under `docs/codex-reports/`.
2. Added `docs/security/phase-0-risk-register.md`.
3. Added Supabase boundary static check and allowlist.
4. Added API + Server Action IDOR/ownership matrix.
5. Added repository-owned offline tests.
6. Added database static check and DB regression harness notes.
7. Audited `crm-ci.yml`, added `ci.yml`, and removed production secret dependency from CI build smoke.
8. Archived PM2 config and documented systemd-only production policy.
9. Ran real validations and pushed to `origin/work`.
10. Created and re-read real GitHub PR `#2`.

## I. Test coverage

- Unit: legal/illegal lead stage transitions; won/lost terminal rollback protection.
- Security/static: lead quality, contract detail, payment confirm, task update, pipeline action, settings reassignment auth/ownership evidence.
- Integration/static: weekly trends period range, pipeline period/sales scoping, quality enum/poor reason validation.
- Regression/static DB: migration ordering, DB trigger/function/evidence tokens, critical RLS enable evidence.

## J. Fixed issues

- CI no longer requires production Supabase/Sentry secrets for build smoke.
- Admin Supabase client now imports `server-only`.
- Supabase boundary script fails on unallowed browser/service-role/client mutation issues.
- DB static harness exists and does not connect to production.
- PM2 root config was moved to deprecated ops docs; production is documented as systemd-only.

## K. Unfixed risks and BLOCKED

- `BASELINE_FAILURE`: `npm run lint` fails with existing lint debt.
- `P0-SB-001 / REVIEW`: Existing browser-reachable Supabase reads/mutations are allowlisted as baseline and must be migrated later.
- `P0-IDOR-001 / REVIEW`: Dynamic multi-user IDOR tests still require a disposable test environment.
- `P0-EXT-001 / BLOCKED_EXTERNAL_SOURCE`: `/home/ubuntu/.hermes/scripts/crm-regression.py` was not readable in this environment; content was not fabricated.
- DB dynamic/RLS regression was not run because this phase did not connect to production DB or start a disposable Supabase DB.

## L. Validation commands and real results

- `git status --short --branch` — clean on `work` before push / after PR confirmation.
- `npm ci` — passed; npm audit reported `6 vulnerabilities (4 moderate, 2 high)`.
- `npm run lint` — failed as `BASELINE_FAILURE`: `19428 problems (1709 errors, 17719 warnings)`.
- `npm run typecheck` — passed.
- `npm test` — passed: `12` tests, `0` failed.
- `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=test-anon-key SUPABASE_SERVICE_ROLE_KEY=test-service-role-key NEXT_PUBLIC_SENTRY_DSN= npm run build` — passed; Sentry emitted expected no-auth-token warnings.
- `bash scripts/check-taskboard.sh` — passed: `PASS 18 / FAIL 0 / WARN 0`.
- `npm run check:supabase-boundaries` — passed with `44` allowlisted/informational baseline findings.
- `npm run check:db-static` — passed; emitted REVIEW for missing explicit tasks RLS enable evidence in migrations.
- `npm run check:route-files` — passed.
- `npm run check:schema-refs` — passed; checked `525` table references.
- `git push origin work` — passed.
- GitHub API PR create/readback — passed; PR `#2` is open.

## M. Migration status

No migration was added, modified, or executed.

## N. Production touch status

No production touch.

Not performed:

- No production DB connection.
- No migration execution.
- No SSH.
- No deploy.
- No systemd restart.
- No PR merge.
- No production data modification.

## O. Next phase recommendations

1. Resolve lint baseline, starting with excluding generated `.next.backup` and then addressing existing `src/**` lint debt in small batches.
2. Migrate allowlisted browser Supabase mutations to server actions/API routes.
3. Add disposable Supabase test DB for dynamic RLS/IDOR regression.
4. Add explicit ownership or dynamic proof for `GET /api/tasks/[id]`.
5. Rotate any token that was exposed outside GitHub secret storage.

## Token handling note

`origin` was restored to the token-free URL:

```text
https://github.com/69755354/newme-platform.git
```

---

# Phase 0.5 Re-review Update

This section supersedes stale Phase 0 head-SHA facts above. It records the Phase 0.5 changes requested by GPT-5.6 review on PR #2.

## Phase 0.5 fixes

- Fixed malformed `.github/workflows/crm-ci.yml` YAML.
- Split workflow responsibilities: `ci` is the main repository validation workflow; `crm-ci` is now the Hermes `workflow_run` contract and does not duplicate npm install/build/test gates.
- Replaced permanently-red CI lint gate with `npm run lint:baseline`, which excludes generated/non-source directories, preserves the current baseline, and fails only on newly introduced lint errors.
- Added `npm run lint:baseline:negative` to prove a deliberate new lint parse error is blocked.
- Added `npm run check:workflows` YAML validation for all workflow files.
- Clarified that current tests are static/offline evidence tests, not dynamic multi-user IDOR/RLS/trigger regression.
- Added npm audit runtime/dev classification to the risk register and security audit.

## Workflow responsibility split

| Workflow | Required check | Trigger | Responsibility |
|---|---|---|---|
| `ci` | `Repository validation` | `pull_request`, `push` to `work`/`main`/`production`, manual | Runs install, taskboard, route/schema gates, Supabase boundary, DB static, lint baseline, workflow YAML validation, typecheck, tests, and build smoke. |
| `crm-ci` | `Hermes CI webhook contract` | `workflow_run` after `ci`, manual | Serves as Hermes webhook subscription target and fails when upstream `ci` is not successful. |

## Lint baseline policy

- Full historical `npm run lint` remains a known baseline failure.
- CI uses `npm run lint:baseline` instead of `npm run lint`.
- The baseline excludes `.next/**`, `.next.backup/**`, `node_modules/**`, `docs/**`, `supabase/**`, and `coverage/**`.
- `scripts/lint-baseline.json` stores the current controlled baseline.
- New errors fail the gate.
- The negative test creates a temporary invalid JS file and confirms the gate fails.

## npm audit classification

`npm audit --omit=dev` and full `npm audit` returned the same summary:

- Runtime: 4 moderate, 2 high, 0 critical.
- Dev-only delta: none observed in this run.
- Direct high: `xlsx`.
- Transitive high: `hono` via runtime dependency chain.
- Moderate: `@sentry/nextjs`/`next`/`postcss`/`dompurify` related paths.

No blind dependency upgrade was performed in Phase 0.5.

## Phase 0.5 validation matrix

- Workflow YAML validation: `npm run check:workflows` — PASS.
- Lint baseline positive: `npm run lint:baseline` — PASS.
- Lint baseline negative: `npm run lint:baseline:negative` — PASS; deliberate new lint error was blocked.
- Typecheck: `npm run typecheck` — PASS.
- Tests: `npm test` — PASS.
- Build: safe placeholder `npm run build` — PASS expected after previous Phase 0 validation; re-run before final push/comment.
- Supabase boundary: `npm run check:supabase-boundaries` — PASS.
- DB static: `npm run check:db-static` — PASS.
- Route gate: `npm run check:route-files` — PASS.
- Schema gate: `npm run check:schema-refs` — PASS.
- Migration status: no migration added, modified, or executed.
- Production touch status: no production DB, no SSH, no deploy, no restart, no merge.

## Latest-head note

The authoritative latest remote head is the PR #2 `head.sha` read from GitHub after the final Phase 0.5 push. Do not rely on the older Phase 0 SHA above.
