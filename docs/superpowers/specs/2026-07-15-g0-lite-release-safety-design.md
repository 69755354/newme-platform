# G0-Lite Release Safety Design

## Goal

Make every NewMe CRM production deployment build from one reviewed, CI-green `origin/main` commit and leave evidence that connects the deployed Git SHA, Next.js BUILD_ID, migration state, authenticated UAT result, and rollback target.

## Evidence behind this design

- `main` is currently `b7cb1882786f6f1b311b6258acc318cd1b72a3f2`.
- The existing G0 branch is seven commits ahead of `main` and contains the three PR #24 import-idempotency commits plus four G0 commits, so it is not an isolated release-safety change.
- Its committed authorization document contains demonstration PR, CI, reviewer, and GO values.
- Its deploy gate skips authorization when the file is absent and permits selected dirty files.
- Its HEAD `746f04261de3a60752757c71e1e1c4838750723c` has no GitHub Actions run.
- The detached-worktree build idea is useful, but the branch must not be merged or cherry-picked as a unit.

## Scope

G0-Lite changes only the production deployment guard, release evidence finalization, and their tests.

It must:

1. Reject deployment unless the mutable server checkout is on `main`.
2. Fetch `origin/main`, reject when `HEAD != origin/main`, and reject every tracked, staged, or untracked workspace change without exceptions.
3. Set `RELEASE_SHA` exactly once from the verified `HEAD`.
4. Require CI metadata before any production build mutation:
   - run ID and URL,
   - conclusion `success`,
   - CI head SHA exactly equal to `RELEASE_SHA`.
5. Build from a detached Git worktree at `RELEASE_SHA`; the mutable server checkout is not copied into the build.
6. Preserve the current `.next` as the rollback build before swapping.
7. Write deployment evidence containing:
   - release Git SHA,
   - deployed BUILD_ID,
   - CI run ID, URL, conclusion, and head SHA,
   - migration status and exact migration IDs,
   - UAT status, actor, timestamp, fixture IDs, and cleanup status,
   - rollback Git SHA, BUILD_ID, and backup directory,
   - build, systemd, log, smoke, and final release status.
8. Keep the final release status incomplete until authenticated UI UAT passes and fixture cleanup is recorded.
9. Fail before swapping `.next` when required release metadata is missing or inconsistent.

## Non-goals

G0-Lite does not:

- merge, deploy, or apply PR #24;
- add Git/Hermes polling, listener leases, or autonomous release orchestration;
- modify pre-commit marker behavior;
- store reusable `codex_go` flags or committed per-release authorization files;
- change product source, database schema, or production data;
- infer completion from CI success, HTTP 200, or a merged PR.

## Components

### `scripts/verify-release-preflight.sh`

Perform the read-only Git and release-input checks as a small fail-closed unit. It prints only the verified full `RELEASE_SHA` on success and writes all failure reasons to stderr. `deploy.sh` invokes it before any systemd, taskboard, typecheck, backup, or build action. Keeping this boundary separate allows behavioral tests in temporary Git repositories without executing the production deployment pipeline.

### `scripts/deploy.sh`

Keep the existing deployment pipeline and make a surgical change:

- run strict main/SHA/cleanliness and CI/migration checks as the first operational step, before systemd start, taskboard, typecheck, backup, or build;
- validate operator-supplied CI and migration evidence;
- derive `RELEASE_SHA` only from the verified checkout;
- replace the rsync source copy with `git worktree add --detach "$BUILD_DIR" "$RELEASE_SHA"`;
- copy only the existing ignored runtime input `.env.local` into the worktree;
- remove the detached worktree in the existing exit trap;
- capture the generated `.next/BUILD_ID`;
- write an evidence document whose successful deploy state is `awaiting_uat`, never `complete`.

Required release inputs are environment variables so secrets are not committed:

- `CI_RUN_ID`
- `CI_RUN_URL`
- `CI_HEAD_SHA`
- `CI_CONCLUSION=success`
- `MIGRATION_STATUS=not_required|applied_verified`
- `MIGRATION_IDS` as a comma-separated exact list, empty only for `not_required`
- `ROLLBACK_GIT_SHA`

The rollback BUILD_ID and backup directory are read from the currently deployed `.next` and the backup created by the deploy.

### `scripts/finalize-deploy-evidence.sh`

Finalize exactly one evidence file after authenticated production UI UAT.

Inputs:

- evidence file path;
- `UAT_STATUS=pass|fail`;
- authenticated UAT actor;
- exact fixture ID list;
- `FIXTURE_CLEANUP_STATUS=not_required|archived_verified`.

The finalizer validates that the evidence release SHA and BUILD_ID are nonblank, deployment checks passed, UAT metadata is complete, and fixture cleanup is verified. It sets `release_status=complete` only when UAT passes and cleanup is acceptable. A failed UAT records failure and leaves the release incomplete.

### `tests/release/g0-lite.test.mjs`

Use temporary Git repositories and command shims to test behavior without touching production. The test is included in the existing `npm test` path.

It covers:

- non-main checkout rejected;
- main behind `origin/main` rejected;
- tracked, staged, and untracked changes each rejected;
- missing CI fields rejected;
- non-success CI rejected;
- CI head SHA mismatch rejected;
- detached worktree uses the verified release SHA;
- evidence contains every required field;
- missing or failed UAT cannot produce `release_status=complete`;
- passing UAT plus verified fixture cleanup completes the evidence.

## Data flow

1. Codex reviews a GitHub PR at exact head SHA and verifies its CI run.
2. The PR is merged.
3. On the production server, the operator fetches and fast-forwards the `main` checkout.
4. The operator invokes `deploy.sh` with CI, migration, and rollback metadata.
5. The script independently re-fetches `origin/main`, verifies the checkout, creates a detached worktree, builds, swaps, restarts systemd, checks logs/smoke, and writes `awaiting_uat` evidence.
6. Codex performs authenticated positive and negative UI UAT with uniquely prefixed fixtures.
7. Fixtures are archived by exact ID and read back.
8. The finalizer records UAT and cleanup. Only then may evidence say `complete`.

## Error handling and rollback

- All Git/SHA/clean/CI/migration guard failures occur before systemd, backup, or build mutation.
- Build failure removes only the detached worktree and leaves the live `.next` untouched.
- Restart, log, smoke, or UAT failure leaves evidence incomplete and identifies the rollback target.
- Rollback restores the recorded backup BUILD_ID and records the target Git SHA; rollback is never inferred from a branch name.
- Evidence is written on both success and failure through the existing exit trap.

## Verification

Before merge:

- targeted G0-Lite tests pass;
- full `npm test`, typecheck, lint baseline, workflow validation, and build pass;
- GitHub Actions run is bound to the reviewed PR head SHA;
- diff contains only the design/plan, three focused scripts, and focused tests.

For production proof:

- server checkout is clean `main` and equals `origin/main`;
- evidence release SHA equals GitHub merged `main` SHA;
- evidence BUILD_ID equals the live `.next/BUILD_ID`;
- systemd is active and logs/smoke are clean;
- authenticated positive and negative UAT pass;
- fixture cleanup is verified by exact ID;
- evidence is finalized as `complete` with a recorded rollback target.

## Acceptance criteria

G0-Lite is complete only when the code is merged, the exact merged SHA has green CI, a production deployment built that SHA in a detached worktree, and finalized evidence proves BUILD_ID, migration state, authenticated UAT, cleanup, and rollback identity. A PR, CI run, deploy script exit code, or page 200 alone is insufficient.
