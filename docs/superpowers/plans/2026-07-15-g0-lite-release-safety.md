# G0-Lite Release Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NewMe CRM production deployments fail closed unless they build an exact clean `origin/main` SHA with matching green CI metadata, then produce finalizable evidence for BUILD_ID, migration, authenticated UAT, cleanup, and rollback.

**Architecture:** A small read-only preflight script owns Git and release-input validation. The existing deploy pipeline calls it before any production mutation, builds the verified SHA in a detached worktree, and writes `awaiting_uat` evidence. A separate finalizer atomically records authenticated UAT and is the only path to `release_status=complete`.

**Tech Stack:** Bash, Git, Python 3 standard library, Node.js 20 `node:test`, GitHub Actions.

## Global Constraints

- GitHub is the only development work surface; do not use a local checkout for implementation commits.
- Start from `main=b7cb1882786f6f1b311b6258acc318cd1b72a3f2` on `codex/g0-lite-release-safety`.
- Do not merge, deploy, or apply PR #24 as part of G0-Lite.
- Do not enable Git/Hermes polling, listener leases, or autonomous coordination.
- Reject non-main, `HEAD != origin/main`, and every tracked, staged, or untracked change without exceptions.
- Build only the verified full SHA through a detached Git worktree.
- Never store credentials, reusable GO flags, or per-release authorization values in Git.
- A green PR, merge, script exit code, or HTTP 200 is not production completion.
- Use GitHub Actions at the exact reviewed SHA for every RED/GREEN and full-verification claim.

---

## File map

- Create `scripts/verify-release-preflight.sh`: fail-closed Git, CI, migration, and rollback-input validation; print the verified SHA on success.
- Modify `scripts/deploy.sh`: call preflight first, build a detached worktree, capture BUILD_ID and rollback identity, and write incomplete-until-UAT evidence.
- Create `scripts/finalize-deploy-evidence.sh`: validate and atomically finalize one evidence file after authenticated UAT.
- Create `tests/release/g0-lite-preflight.test.mjs`: behavioral temporary-repository tests for the preflight gate.
- Create `tests/release/g0-lite-deploy-contract.test.mjs`: focused contract test for deploy ordering, detached worktree, and evidence fields.
- Create `tests/release/g0-lite-finalizer.test.mjs`: behavioral tests for evidence finalization.
- Modify `docs/superpowers/specs/2026-07-15-g0-lite-release-safety-design.md` only if implementation evidence reveals a contradiction.
- Modify `docs/superpowers/plans/2026-07-15-g0-lite-release-safety.md` only to mark executed checkboxes and record exact evidence.

---

### Task 1: Fail-closed release preflight

**Files:**
- Create: `tests/release/g0-lite-preflight.test.mjs`
- Create: `scripts/verify-release-preflight.sh`

**Interfaces:**
- Consumes: current Git repository; `CI_RUN_ID`, `CI_RUN_URL`, `CI_HEAD_SHA`, `CI_CONCLUSION`, `MIGRATION_STATUS`, `MIGRATION_IDS`, and `ROLLBACK_GIT_SHA`.
- Produces: full verified release SHA on stdout; nonzero exit and one reason on stderr for every rejection.

- [ ] **Step 1: Commit the failing behavioral test**

Create `tests/release/g0-lite-preflight.test.mjs` with helpers that create a bare origin and a clean `main` clone in a temporary directory. The complete test matrix is:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const preflight = join(repoRoot, "scripts", "verify-release-preflight.sh");

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8" });
}

function git(cwd, ...args) {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "newme-g0-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  assert.equal(run("git", ["init", "--bare", origin], root).status, 0);
  assert.equal(run("git", ["clone", origin, work], root).status, 0);
  git(work, "config", "user.email", "g0@test.local");
  git(work, "config", "user.name", "G0 Test");
  await writeFile(join(work, "README.md"), "seed\n");
  git(work, "add", "README.md");
  git(work, "commit", "-m", "seed");
  git(work, "branch", "-M", "main");
  git(work, "push", "-u", "origin", "main");
  const sha = git(work, "rev-parse", "HEAD");
  return { root, origin, work, sha };
}

function releaseEnv(sha, overrides = {}) {
  return {
    ...process.env,
    CI_RUN_ID: "29351813434",
    CI_RUN_URL: "https://github.com/69755354/newme-platform/actions/runs/29351813434",
    CI_HEAD_SHA: sha,
    CI_CONCLUSION: "success",
    MIGRATION_STATUS: "not_required",
    MIGRATION_IDS: "",
    ROLLBACK_GIT_SHA: sha,
    ...overrides,
  };
}

function verify(work, env) {
  return run("bash", [preflight], work, env);
}

test("accepts only clean main at origin/main with SHA-bound green CI", async () => {
  const { work, sha } = await fixture();
  const result = verify(work, releaseEnv(sha));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), sha);
});

test("rejects non-main and behind-main checkouts", async (t) => {
  await t.test("non-main", async () => {
    const { work, sha } = await fixture();
    git(work, "checkout", "-b", "feature");
    const result = verify(work, releaseEnv(sha));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be main/);
  });

  await t.test("behind origin/main", async () => {
    const { work, sha } = await fixture();
    await appendFile(join(work, "README.md"), "remote\n");
    git(work, "add", "README.md");
    git(work, "commit", "-m", "remote");
    git(work, "push", "origin", "main");
    git(work, "reset", "--hard", sha);
    const result = verify(work, releaseEnv(sha));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HEAD != origin\/main/);
  });
});

test("rejects tracked, staged, and untracked dirt without exceptions", async (t) => {
  for (const kind of ["tracked", "staged", "untracked"]) {
    await t.test(kind, async () => {
      const { work, sha } = await fixture();
      if (kind === "untracked") {
        await writeFile(join(work, "untracked.txt"), "dirty\n");
      } else {
        await appendFile(join(work, "README.md"), "dirty\n");
        if (kind === "staged") git(work, "add", "README.md");
      }
      const result = verify(work, releaseEnv(sha));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /working tree is not clean/);
    });
  }
});

test("rejects missing, failed, forged, or SHA-mismatched CI evidence", async (t) => {
  const cases = [
    ["missing run", { CI_RUN_ID: "" }, /CI_RUN_ID/],
    ["failed conclusion", { CI_CONCLUSION: "failure" }, /CI_CONCLUSION/],
    ["wrong SHA", { CI_HEAD_SHA: "0".repeat(40) }, /CI_HEAD_SHA/],
    ["wrong URL", { CI_RUN_URL: "https://example.com/actions/runs/29351813434" }, /CI_RUN_URL/],
  ];
  for (const [name, overrides, pattern] of cases) {
    await t.test(name, async () => {
      const { work, sha } = await fixture();
      const result = verify(work, releaseEnv(sha, overrides));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
    });
  }
});

test("requires exact migration and rollback metadata", async (t) => {
  await t.test("applied migration needs IDs", async () => {
    const { work, sha } = await fixture();
    const result = verify(work, releaseEnv(sha, {
      MIGRATION_STATUS: "applied_verified",
      MIGRATION_IDS: "",
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MIGRATION_IDS/);
  });

  await t.test("rollback SHA must resolve to a commit", async () => {
    const { work, sha } = await fixture();
    const result = verify(work, releaseEnv(sha, {
      ROLLBACK_GIT_SHA: "0".repeat(40),
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_GIT_SHA/);
  });
});
```

Commit only this test to the GitHub branch with message:

```text
test: reproduce missing G0-Lite release preflight
```

- [ ] **Step 2: Verify RED on the exact test commit**

GitHub Actions must finish with failure at the test commit. Inspect the failing job log.

Run represented by CI:

```bash
node --test tests/release/g0-lite-preflight.test.mjs
```

Expected failure: `scripts/verify-release-preflight.sh` is absent, so the first positive assertion fails before any production code exists.

- [ ] **Step 3: Commit the minimal preflight implementation**

Create `scripts/verify-release-preflight.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "G0-Lite preflight: $1" >&2
  exit 1
}

require_nonempty() {
  local name="$1"
  [ -n "${!name:-}" ] || fail "$name is required"
}

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[ -n "$PROJECT_ROOT" ] || fail "not inside a Git repository"
cd "$PROJECT_ROOT"

CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[ "$CURRENT_BRANCH" = "main" ] || fail "checkout must be main (current: ${CURRENT_BRANCH:-detached})"

git fetch origin main --quiet
RELEASE_SHA="$(git rev-parse HEAD)"
ORIGIN_MAIN_SHA="$(git rev-parse refs/remotes/origin/main)"
[ "$RELEASE_SHA" = "$ORIGIN_MAIN_SHA" ] || fail "HEAD != origin/main"

DIRTY="$(git status --porcelain --untracked-files=all)"
[ -z "$DIRTY" ] || fail "working tree is not clean"

for name in CI_RUN_ID CI_RUN_URL CI_HEAD_SHA CI_CONCLUSION MIGRATION_STATUS ROLLBACK_GIT_SHA; do
  require_nonempty "$name"
done
[ "${MIGRATION_IDS+x}" = "x" ] || fail "MIGRATION_IDS is required (empty only when migration is not_required)"

case "$CI_RUN_ID" in
  *[!0-9]*|"") fail "CI_RUN_ID must be numeric" ;;
esac
EXPECTED_CI_URL="https://github.com/69755354/newme-platform/actions/runs/$CI_RUN_ID"
[ "$CI_RUN_URL" = "$EXPECTED_CI_URL" ] || fail "CI_RUN_URL must equal $EXPECTED_CI_URL"
[ "$CI_CONCLUSION" = "success" ] || fail "CI_CONCLUSION must be success"
[ "$CI_HEAD_SHA" = "$RELEASE_SHA" ] || fail "CI_HEAD_SHA must equal release SHA"

case "$MIGRATION_STATUS" in
  not_required)
    [ -z "$MIGRATION_IDS" ] || fail "MIGRATION_IDS must be empty when migration is not_required"
    ;;
  applied_verified)
    [ -n "$MIGRATION_IDS" ] || fail "MIGRATION_IDS is required when migration is applied_verified"
    ;;
  *)
    fail "MIGRATION_STATUS must be not_required or applied_verified"
    ;;
esac

case "$ROLLBACK_GIT_SHA" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*)
    [ "${#ROLLBACK_GIT_SHA}" -eq 40 ] || fail "ROLLBACK_GIT_SHA must be a full 40-character SHA"
    ;;
  *)
    fail "ROLLBACK_GIT_SHA must be a full 40-character SHA"
    ;;
esac
git cat-file -e "${ROLLBACK_GIT_SHA}^{commit}" 2>/dev/null || fail "ROLLBACK_GIT_SHA does not resolve to a commit"

printf '%s\n' "$RELEASE_SHA"
```

Commit with message:

```text
feat: add fail-closed G0-Lite preflight
```

- [ ] **Step 4: Verify GREEN**

GitHub Actions must pass the targeted test at the implementation SHA.

Expected: 5 top-level tests pass, including all nested rejection cases.

---

### Task 2: Detached-SHA deploy and incomplete-until-UAT evidence

**Files:**
- Create: `tests/release/g0-lite-deploy-contract.test.mjs`
- Modify: `scripts/deploy.sh`

**Interfaces:**
- Consumes: verified SHA printed by `scripts/verify-release-preflight.sh`; existing deploy checks, build, swap, smoke, logs, and regression flow.
- Produces: `.hermes-harness/deploy-evidence/<deploy-id>.json` with `release_status=awaiting_uat` after a successful deployment.

- [ ] **Step 1: Commit the failing deploy contract test**

Create `tests/release/g0-lite-deploy-contract.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const deploy = await readFile(
  new URL("../../scripts/deploy.sh", import.meta.url),
  "utf8",
);

test("preflight runs before any systemd mutation", () => {
  const preflight = deploy.indexOf("verify-release-preflight.sh");
  const systemd = deploy.indexOf("systemctl");
  assert.ok(preflight >= 0, "missing G0-Lite preflight");
  assert.ok(systemd >= 0, "missing systemd flow");
  assert.ok(preflight < systemd, "preflight must run before systemd");
});

test("build source is the verified SHA in a detached worktree", () => {
  assert.ok(deploy.includes('RELEASE_SHA="$(bash "$PROJECT_ROOT/scripts/verify-release-preflight.sh")"'));
  assert.ok(deploy.includes('git worktree add --detach "$BUILD_DIR" "$RELEASE_SHA"'));
  assert.ok(deploy.includes('git worktree remove "$BUILD_DIR" --force'));
  assert.equal(deploy.includes("rsync -a --delete"), false);
});

test("deploy evidence contains the complete release identity contract", () => {
  for (const token of [
    '"git_sha"',
    '"build_id"',
    '"ci"',
    '"head_sha"',
    '"migration"',
    '"uat"',
    '"fixture_ids"',
    '"cleanup_status"',
    '"rollback"',
    '"backup_dir"',
    '"systemd"',
    '"release_status"',
    '"awaiting_uat"',
  ]) {
    assert.ok(deploy.includes(token), `missing evidence token: ${token}`);
  }
  assert.equal(deploy.includes('"release_status": "complete"'), false);
});
```

Commit with message:

```text
test: reproduce unsafe deploy source and incomplete evidence
```

- [ ] **Step 2: Verify RED**

GitHub Actions must fail this test against the current rsync-based `deploy.sh`.

Expected failures: missing preflight call, missing detached worktree command, and missing evidence fields.

- [ ] **Step 3: Apply the minimal deploy diff**

In `scripts/deploy.sh`:

1. Immediately after resolving `PROJECT_ROOT`, run:

```bash
RELEASE_SHA="$(bash "$PROJECT_ROOT/scripts/verify-release-preflight.sh")"
```

This line must appear before the first `systemctl` command.

2. Initialize evidence identity:

```bash
COMMIT_HASH="$RELEASE_SHA"
NEW_BUILD_ID=""
BACKUP_DIR=""
EXISTING_BUILD_ID=""
EVI_SYSTEMD_STATUS="pending"
EVI_RELEASE_STATUS="failed"
```

3. Extend `write_evidence` with these exact top-level objects while preserving existing build/smoke/log/regression/health evidence:

```json
{
  "git_sha": "$RELEASE_SHA",
  "build_id": "$NEW_BUILD_ID",
  "ci": {
    "run_id": "$CI_RUN_ID",
    "run_url": "$CI_RUN_URL",
    "head_sha": "$CI_HEAD_SHA",
    "conclusion": "$CI_CONCLUSION"
  },
  "migration": {
    "status": "$MIGRATION_STATUS",
    "ids": "$MIGRATION_IDS"
  },
  "uat": {
    "status": "pending",
    "actor": "",
    "completed_at": "",
    "fixture_ids": "",
    "cleanup_status": "pending"
  },
  "rollback": {
    "git_sha": "$ROLLBACK_GIT_SHA",
    "build_id": "$EXISTING_BUILD_ID",
    "backup_dir": "$BACKUP_DIR"
  },
  "systemd": {
    "status": "$EVI_SYSTEMD_STATUS",
    "service": "newme-platform.service"
  },
  "release_status": "$EVI_RELEASE_STATUS"
}
```

4. Update the exit cleanup before `rm -rf "$BUILD_DIR"`:

```bash
cd "$PROJECT_ROOT" 2>/dev/null || true
git worktree remove "$BUILD_DIR" --force 2>/dev/null || true
```

5. Replace the rsync build-source block with:

```bash
echo "📋 Creating detached worktree at $RELEASE_SHA..."
rm -rf "$BUILD_DIR"
git worktree add --detach "$BUILD_DIR" "$RELEASE_SHA"
[ -f "$PROJECT_ROOT/.env.local" ] && cp "$PROJECT_ROOT/.env.local" "$BUILD_DIR/.env.local"
echo "✅ Worktree ready at $RELEASE_SHA"
```

6. After the restarted service passes health, set:

```bash
EVI_SYSTEMD_STATUS="pass"
```

7. At the successful end, replace a completion claim with:

```bash
EVI_RESULT="pass"
EVI_RELEASE_STATUS="awaiting_uat"
echo "Release status: awaiting authenticated UAT"
echo "Evidence: $EVIDENCE_FILE"
```

Commit with message:

```text
feat: bind deploy to clean main SHA and release evidence
```

- [ ] **Step 4: Verify GREEN and shell syntax**

GitHub Actions must pass:

```bash
node --test tests/release/g0-lite-deploy-contract.test.mjs
bash -n scripts/deploy.sh
bash -n scripts/verify-release-preflight.sh
```

Expected: all contract assertions and syntax checks pass.

---

### Task 3: Authenticated UAT evidence finalizer

**Files:**
- Create: `tests/release/g0-lite-finalizer.test.mjs`
- Create: `scripts/finalize-deploy-evidence.sh`

**Interfaces:**
- Consumes: one deploy evidence path plus `UAT_STATUS`, `UAT_ACTOR`, `UAT_FIXTURE_IDS`, and `FIXTURE_CLEANUP_STATUS`.
- Produces: atomically updated evidence; `complete` only for passing authenticated UAT with acceptable cleanup.

- [ ] **Step 1: Commit the failing finalizer test**

Create `tests/release/g0-lite-finalizer.test.mjs`. The fixture must contain pass statuses for build, smoke, logs, regression, health, and systemd; matching CI/release SHA; verified migration status; nonblank rollback identity; and `release_status=awaiting_uat`.

Test these exact cases:

```js
test("missing authenticated actor cannot complete release", async () => {
  // UAT_STATUS=pass with empty UAT_ACTOR exits nonzero and remains awaiting_uat.
});

test("failed UAT is recorded and leaves release incomplete", async () => {
  // UAT_STATUS=fail exits nonzero, records uat.status=fail, and sets uat_failed.
});

test("fixture IDs require archived_verified cleanup", async () => {
  // A nonempty exact fixture list with cleanup=not_required exits nonzero.
});

test("passing authenticated UAT and exact cleanup complete release", async () => {
  // UAT_STATUS=pass, actor=Codex, fixture IDs, archived_verified => complete.
});

test("no-fixture UAT accepts not_required cleanup", async () => {
  // UAT_STATUS=pass, actor=Codex, empty fixture IDs, not_required => complete.
});
```

The test invokes:

```bash
bash scripts/finalize-deploy-evidence.sh <absolute-evidence-path>
```

Commit with message:

```text
test: reproduce premature release evidence completion
```

- [ ] **Step 2: Verify RED**

Expected: GitHub Actions fails because `scripts/finalize-deploy-evidence.sh` does not exist.

- [ ] **Step 3: Commit the finalizer**

Create `scripts/finalize-deploy-evidence.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "G0-Lite evidence: $1" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "exactly one evidence file path is required"
EVIDENCE_FILE="$1"
[ -f "$EVIDENCE_FILE" ] || fail "evidence file not found"

: "${UAT_STATUS:?UAT_STATUS is required}"
: "${UAT_ACTOR+x}"
: "${UAT_FIXTURE_IDS+x}"
: "${FIXTURE_CLEANUP_STATUS:?FIXTURE_CLEANUP_STATUS is required}"

python3 - "$EVIDENCE_FILE" "$UAT_STATUS" "$UAT_ACTOR" "$UAT_FIXTURE_IDS" "$FIXTURE_CLEANUP_STATUS" <<'PY'
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

path, uat_status, actor, fixture_text, cleanup = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    evidence = json.load(handle)

def fail(message):
    print(f"G0-Lite evidence: {message}", file=sys.stderr)
    raise SystemExit(1)

if evidence.get("release_status") != "awaiting_uat":
    fail("release_status must be awaiting_uat")

git_sha = evidence.get("git_sha")
build_id = evidence.get("build_id")
if not git_sha or not build_id:
    fail("git_sha and build_id are required")

for section in ("build", "smoke", "logs", "regression", "health", "systemd"):
    if evidence.get(section, {}).get("status") != "pass":
        fail(f"{section}.status must be pass")

ci = evidence.get("ci", {})
if ci.get("conclusion") != "success" or ci.get("head_sha") != git_sha:
    fail("CI evidence is not bound to release SHA")

migration = evidence.get("migration", {})
if migration.get("status") not in {"not_required", "applied_verified"}:
    fail("migration status is not verified")
if migration.get("status") == "applied_verified" and not migration.get("ids"):
    fail("applied migration IDs are required")

rollback = evidence.get("rollback", {})
for field in ("git_sha", "build_id", "backup_dir"):
    if not rollback.get(field):
        fail(f"rollback.{field} is required")

if uat_status not in {"pass", "fail"}:
    fail("UAT_STATUS must be pass or fail")

fixtures = [value.strip() for value in fixture_text.split(",") if value.strip()]
completed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

if uat_status == "fail":
    evidence["uat"] = {
        "status": "fail",
        "actor": actor,
        "completed_at": completed_at,
        "fixture_ids": fixtures,
        "cleanup_status": cleanup,
    }
    evidence["release_status"] = "uat_failed"
else:
    if not actor.strip():
        fail("authenticated UAT actor is required")
    if cleanup not in {"not_required", "archived_verified"}:
        fail("fixture cleanup status is invalid")
    if fixtures and cleanup != "archived_verified":
        fail("fixture IDs require archived_verified cleanup")
    evidence["uat"] = {
        "status": "pass",
        "actor": actor,
        "completed_at": completed_at,
        "fixture_ids": fixtures,
        "cleanup_status": cleanup,
    }
    evidence["release_status"] = "complete"

directory = os.path.dirname(os.path.abspath(path))
fd, temporary = tempfile.mkstemp(prefix=".deploy-evidence-", dir=directory, text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)

if uat_status == "fail":
    raise SystemExit(1)
PY
```

Commit with message:

```text
feat: finalize deploy evidence only after authenticated UAT
```

- [ ] **Step 4: Verify GREEN**

GitHub Actions must pass:

```bash
node --test tests/release/g0-lite-finalizer.test.mjs
bash -n scripts/finalize-deploy-evidence.sh
```

Expected: all five finalizer cases pass.

---

### Task 4: Full GitHub verification and review gate

**Files:**
- Modify: Draft PR #25 description and readiness state only after evidence passes.
- Inspect: all changed files and GitHub Actions logs.

**Interfaces:**
- Consumes: Task 1–3 head SHA.
- Produces: reviewed PR head SHA with complete CI evidence, no scope leakage, and an explicit merge decision.

- [ ] **Step 1: Run the complete repository gate at one exact SHA**

Required GitHub Actions commands:

```bash
npm ci
bash scripts/check-taskboard.sh
npm run check:route-files
npm run check:schema-refs
npm run check:supabase-boundaries
npm run check:db-static
npm run lint:baseline
npm run check:workflows
npm run typecheck
npm test
npm run build
bash -n scripts/verify-release-preflight.sh
bash -n scripts/deploy.sh
bash -n scripts/finalize-deploy-evidence.sh
```

Expected: every command passes in the same workflow run at the PR head SHA.

- [ ] **Step 2: Audit the final diff**

The allowed implementation diff is:

```text
docs/superpowers/specs/2026-07-15-g0-lite-release-safety-design.md
docs/superpowers/plans/2026-07-15-g0-lite-release-safety.md
scripts/verify-release-preflight.sh
scripts/deploy.sh
scripts/finalize-deploy-evidence.sh
tests/release/g0-lite-preflight.test.mjs
tests/release/g0-lite-deploy-contract.test.mjs
tests/release/g0-lite-finalizer.test.mjs
```

Reject any migration, product source, Hermes automation, reusable authorization file, listener, or PR #24 content.

- [ ] **Step 3: Verify CI binding**

Record:

- PR number 25;
- exact PR head SHA;
- successful workflow run ID and URL;
- workflow head SHA equal to the PR head SHA.

Only after this audit may the Draft PR be marked ready.

---

### Task 5: Controlled merge, production deployment, and evidence finalization

**Files:**
- Production runtime evidence only: `.hermes-harness/deploy-evidence/<deploy-id>.json`
- No new repository files.

**Interfaces:**
- Consumes: merged `main` SHA, exact successful CI run, current production Git SHA/BUILD_ID, and authenticated UAT results.
- Produces: live G0-Lite deployment and finalized `release_status=complete` evidence with rollback identity.

- [ ] **Step 1: Merge only the reviewed PR head**

After the PR is ready, re-read PR metadata and CI. Merge PR #25 only if the reviewed head SHA is unchanged.

Verify GitHub `main` moved to the resulting merge SHA.

- [ ] **Step 2: Capture the production rollback identity before updating source**

On the production server, run read-only checks first:

```bash
cd ~/newme-platform
git status --porcelain --untracked-files=all
git branch --show-current
git rev-parse HEAD
cat .next/BUILD_ID
systemctl is-active newme-platform.service
```

Expected: branch `main`, clean status, active systemd, nonblank Git SHA and BUILD_ID. Save the pre-update Git SHA as `ROLLBACK_GIT_SHA`.

- [ ] **Step 3: Fast-forward to the exact merged main SHA**

```bash
git fetch origin main
git merge --ff-only origin/main
git rev-parse HEAD
```

Expected: server HEAD equals GitHub `main` merge SHA.

- [ ] **Step 4: Deploy with exact release evidence**

Use the exact CI values recorded in Task 4 and the production rollback SHA recorded in Task 5 Step 2:

```bash
CI_RUN_ID="$CI_RUN_ID" \
CI_RUN_URL="$CI_RUN_URL" \
CI_HEAD_SHA="$MERGED_MAIN_SHA" \
CI_CONCLUSION="success" \
MIGRATION_STATUS="not_required" \
MIGRATION_IDS="" \
ROLLBACK_GIT_SHA="$ROLLBACK_GIT_SHA" \
bash scripts/deploy.sh
```

Expected: deployment exits zero and prints `Release status: awaiting authenticated UAT` plus the evidence path.

- [ ] **Step 5: Verify deployed identity and runtime**

```bash
git rev-parse HEAD
cat .next/BUILD_ID
systemctl is-active newme-platform.service
bash scripts/check-smoke.sh http://localhost:3001
bash scripts/check-logs.sh "2 minutes ago"
```

Read the evidence and verify:

- `git_sha == MERGED_MAIN_SHA`;
- evidence `build_id` equals live `.next/BUILD_ID`;
- CI head SHA equals merged main SHA;
- migration status is `not_required`;
- rollback Git SHA, BUILD_ID, and backup directory are nonblank;
- `release_status == awaiting_uat`.

- [ ] **Step 6: Perform authenticated production UI UAT**

Using a real authorized account at `https://app.newme.ae`:

1. sign in;
2. load Dashboard and Lead list;
3. open an existing authorized Lead Detail without mutating it;
4. confirm unauthorized access remains rejected for a role-restricted path;
5. confirm no new critical server log entries.

G0-Lite uses no production data fixture, so fixture IDs are empty and cleanup is `not_required`.

- [ ] **Step 7: Finalize evidence**

```bash
UAT_STATUS="pass" \
UAT_ACTOR="Codex authenticated production UAT" \
UAT_FIXTURE_IDS="" \
FIXTURE_CLEANUP_STATUS="not_required" \
bash scripts/finalize-deploy-evidence.sh "$EVIDENCE_FILE"
```

Expected: exit zero and evidence `release_status == complete`.

- [ ] **Step 8: Final completion audit**

G0-Lite is complete only after all of these are proven together:

- merged GitHub main SHA;
- successful CI run bound to that SHA;
- production Git SHA equals merged main SHA;
- live BUILD_ID equals evidence BUILD_ID;
- systemd, smoke, logs, and regression pass;
- authenticated positive and negative UAT pass;
- fixture cleanup is explicitly `not_required`;
- rollback Git SHA, BUILD_ID, and backup directory are recorded;
- final evidence says `complete`.

Then continue to Phase 1; do not mark the overall CRM OS goal complete.
