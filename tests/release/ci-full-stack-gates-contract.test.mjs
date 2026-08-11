import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

test("CI runs on pull requests, main pushes, and manual dispatch", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");
  assert.match(workflow, /^on:\s*\n(?:[\s\S]*?)^  workflow_dispatch:/m);
  assert.match(workflow, /^  pull_request:\s*$/m);
  assert.match(workflow, /^  push:\s*\n    branches:\s*\n      - main\s*$/m);
  // The Windows SPEC gate runs on PRs and on the release-final dispatch that
  // infra/release/required-jobs.json gates production on. It was pull_request-only,
  // which made the required set unsatisfiable for a release-final run.
  assert.match(
    workflow,
    /windows-checkout:[\s\S]*?if: \$\{\{ github\.event_name == 'pull_request' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.release_final\) \}\}/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(
    workflow,
    /sparse-checkout: \|\s*\n\s*crm-v3\/SPEC\.md\s*\n\s*scripts\/check-spec\.sh\s*\n\s*scripts\/run-bash\.mjs\s*\n\s*sparse-checkout-cone-mode: false/,
  );
  assert.match(workflow, /node scripts\/run-bash\.mjs scripts\/check-spec\.sh/);
  assert.match(workflow, /npx playwright install --with-deps chromium/);
  assert.match(
    workflow,
    /npx playwright test --config=playwright\.production-smoke\.config\.ts/,
  );
});

test("ordinary CI and release-final taskboard modes are distinct", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  const shell = await readFile(new URL("scripts/check-taskboard.sh", ROOT), "utf8");
  assert.equal(packageJson.scripts["check:taskboard"], "node scripts/check-taskboard.mjs");
  assert.equal(
    packageJson.scripts["check:taskboard:complete"],
    "node scripts/check-taskboard.mjs --require-complete",
  );
  assert.match(workflow, /- name: Taskboard gate\s*\n        run: npm run check:taskboard/);
  assert.match(workflow, /release_final:[\s\S]*?type: boolean/);
  assert.match(
    workflow,
    /taskboard-completion:[\s\S]*?github\.event_name == 'workflow_dispatch' && inputs\.release_final[\s\S]*?npm run check:taskboard:complete/,
  );
  assert.match(shell, /exec node "\$SCRIPT_DIR\/check-taskboard\.mjs" "\$@"/);
});

test("migration replay job gates on a negative control and never reaches production", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");
  const start = workflow.indexOf("  migration-replay:");
  assert.notEqual(start, -1, "ci.yml must define the migration-replay job");
  const job = workflow.slice(start);

  // A throwaway service container, not a linked project.
  assert.match(job, /image: postgres:17/);
  assert.match(job, /POSTGRES_HOST_AUTH_METHOD: trust/);
  assert.doesNotMatch(
    job,
    /\bsecrets\.|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|supabase\s+link|--linked|PGPASSWORD/i,
  );

  // The control step must come before the gating replay: assertions that hold
  // against the un-remediated floor prove nothing, and running them second would
  // let a vacuous gate report green first.
  const control = job.indexOf("MODE=control");
  const branch = job.indexOf("MODE=branch");
  const history = job.indexOf("MODE=history");
  assert.notEqual(control, -1, "the negative control step must exist");
  assert.notEqual(branch, -1, "the gating replay step must exist");
  assert.ok(control < branch, "the negative control must run before the gating replay");

  // All three modes gate. The reviewed revision allowed exactly one
  // continue-on-error step — the history replay — and this test asserted its
  // presence, so the false green was written into the contract. A step whose
  // result is discarded is not evidence of anything, so there is now no
  // continue-on-error in this job at all, and the assertion runs the other way.
  // Anchored to a YAML key so the comment recording that history does not satisfy
  // its own assertion.
  assert.doesNotMatch(job, /^\s*continue-on-error\s*:/m);
  assert.notEqual(history, -1, "the full-history replay step must exist");
  assert.ok(history > branch, "the full-history replay must run after the branch replay");

  // And it must be gating against a recorded failure point, not printed and
  // ignored: the expectation file is what makes a red step actionable.
  assert.match(job, /- name: Full migration history replay against the recorded failure point/);
  assert.match(job, /history-replay-expectation\.txt/);

  // The history immutability gate is a precondition for every replay below it:
  // if applied migrations have been edited or renamed, the replay is measuring a
  // history production does not have.
  const historyGate = job.indexOf("npm run check:migration-history");
  assert.notEqual(historyGate, -1, "the migration history immutability gate must run in this job");
  assert.ok(historyGate < control, "the history immutability gate must run before the replays");
  // It cross-checks the manifest against BASE_COMMIT with git, and fails rather
  // than warning when that commit is absent.
  assert.match(job.slice(0, historyGate), /fetch-depth: 0/);
});

test("local database job is pinned, isolated, repeatable, and has no remote credential path", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");
  const start = workflow.indexOf("  local-database:");
  assert.notEqual(start, -1);
  const localJob = workflow.slice(start);
  assert.match(localJob, /uses: actions\/checkout@v4\s*\n        with:\s*\n          fetch-depth: 0/);
  assert.match(localJob, /name: Narrow task follow-up database contract/);
  assert.match(localJob, /uses: supabase\/setup-cli@v3/);
  assert.match(localJob, /version: 2\.113\.0/);
  assert.match(localJob, /node supabase\/ci-local\/verify-provenance\.mjs/);
  assert.match(localJob, /supabase db start --workdir supabase\/ci-local/);
  assert.equal(
    localJob.match(/supabase db reset --local --workdir supabase\/ci-local --yes/g)?.length,
    2,
  );
  assert.equal(localJob.match(/node supabase\/ci-local\/verify-reset\.mjs/g)?.length, 2);
  assert.match(
    localJob,
    /supabase test db --local --workdir supabase\/ci-local supabase\/ci-local\/supabase\/tests\/database/,
  );
  assert.match(
    localJob,
    /printf '%s\\n' "\$test_output" \| node scripts\/verify-pgtap-output\.mjs/,
  );
  assert.match(
    localJob,
    /supabase stop --project-id newme-ci-task-followup-v1 --no-backup/,
  );
  assert.doesNotMatch(
    localJob,
    /\bsecrets\.|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|supabase\s+link|--linked|\bdb\s+(?:push|pull|dump)\b/i,
  );
  assert.doesNotMatch(localJob, /--workdir\s+supabase(?:\s|$)/m);
});
