/**
 * The canonical deploy accepted whatever CI/migration claim it was handed.
 *
 * scripts/deploy-immutable.sh writes the permanent release evidence file, and the
 * ci.* / migration.* blocks in it are not measured — they are read from the
 * environment and serialised verbatim. Before this change nothing checked that
 * CI_HEAD_SHA was the SHA being deployed, that CI_CONCLUSION said success, that
 * CI_RUN_URL pointed at CI_RUN_ID, that the run came from an event which actually
 * runs the full gate set, or that MIGRATION_STATUS=applied came with any migration
 * ids. Presence was enforced only incidentally, by a Python KeyError several
 * hundred lines later — after the release had already been switched live.
 *
 * These tests EXECUTE validate_release_claims(), lifted verbatim out of the
 * script, rather than reading its source: the function is the boundary, and a
 * regex over shell text cannot tell a check from a comment about a check. The
 * function's only dependency is $SHA, so it runs standalone with no filesystem,
 * no network and nothing to mutate.
 *
 * The wrapper's own GitHub-API check is exercised the same way, because the two
 * layers must agree about what a valid claim looks like. The reviewed revision of
 * that check accepted exactly one run shape — a green `push` run on main — and
 * that shape structurally cannot contain the explicit predeploy taskboard job,
 * which ci.yml runs on workflow_dispatch. Both deployment layers now require a
 * release-candidate dispatch, and the wrapper additionally measures every job
 * named in infra/release/required-jobs.json. Release-final is a later closure-SHA
 * dispatch and cannot be a precondition of the deployment that creates its facts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEPLOY = path.join(ROOT, "scripts/deploy-immutable.sh");
const WRAPPER = path.join(ROOT, "infra/systemd/newme-deploy.sh");

const RELEASE_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const RUN_ID = "29351813434";

/** Lift a top-level shell function out of a script by name, brace-matched at column 0. */
function extractShellFunction(file, name) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `${path.basename(file)} no longer defines ${name}()`);
  const end = lines.indexOf("}", start);
  assert.notEqual(end, -1, `${name}() has no closing brace at column 0`);
  return lines.slice(start, end + 1).join("\n");
}

const VALIDATE = extractShellFunction(DEPLOY, "validate_release_claims");
const TMP = mkdtempSync(path.join(tmpdir(), "newme-release-claims-"));

const VALID_CLAIM = {
  CI_RUN_ID: RUN_ID,
  CI_RUN_URL: `https://github.com/69755354/newme-platform/actions/runs/${RUN_ID}`,
  CI_HEAD_SHA: RELEASE_SHA,
  CI_CONCLUSION: "success",
  CI_EVENT: "workflow_dispatch",
  CI_WORKFLOW_ID: "310914082",
  CI_WORKFLOW_PATH: ".github/workflows/ci.yml",
  CI_RUN_COMPLETED_AT: "2026-08-15T00:00:00Z",
  CI_GATE_AUDIT_SHA256: "a".repeat(64),
  CI_GATE_AUDITED_AT: "2026-08-15T00:01:00Z",
  CI_GATE_AUDIT_RECORD: "/var/lib/newme/deploy-state/ci-gate-audit.pending",
  CI_MAX_RUN_AGE_SECONDS: "86400",
  MIGRATION_STATUS: "not_required",
  MIGRATION_IDS: "",
};

/**
 * Run the real function with a claim. `undefined` in overrides means "unset",
 * which is how a caller that simply forgets a variable reaches this code.
 */
function validate(overrides = {}) {
  const claim = { ...VALID_CLAIM, ...overrides };
  const harness = path.join(TMP, "harness.sh");
  writeFileSync(
    harness,
    [
      "set -Eeuo pipefail",
      `SHA=${JSON.stringify(RELEASE_SHA)}`,
      VALIDATE,
      "validate_release_claims",
      'echo ACCEPTED',
      "",
    ].join("\n"),
  );

  const env = { ...process.env };
  for (const key of Object.keys(VALID_CLAIM)) delete env[key];
  for (const [key, value] of Object.entries(claim)) {
    if (value !== undefined) env[key] = value;
  }

  const bash = process.platform === "win32"
    ? path.join(env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "bash";
  if (process.platform === "win32") {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = [path.dirname(bash), env[pathKey] ?? ""].filter(Boolean).join(path.delimiter);
  }
  const result = spawnSync(bash, [harness], { encoding: "utf8", env });
  return {
    accepted: result.status === 0 && result.stdout.includes("ACCEPTED"),
    status: result.status,
    stderr: result.stderr,
  };
}

function assertRejected(overrides, reason) {
  const result = validate(overrides);
  assert.equal(result.accepted, false, `claim was accepted: ${JSON.stringify(overrides)}`);
  assert.match(result.stderr, reason);
}

test("a complete, self-consistent claim for the SHA being deployed is accepted", () => {
  const result = validate();
  assert.equal(result.accepted, true, result.stderr);
  assert.equal(result.stderr, "");

  // applied_verified is the other accepted shape, and it must carry ids. This
  // function judges the SHAPE of the claim, not its scope: whether those ids are
  // the set the release requires is decided after `git archive`, against that
  // tree's own manifest, because at this point the SHA's tree does not exist yet.
  // A single id is well-formed here and is refused there
  // (tests/release/release-claim-derivation.test.mjs, round-4 C4-1).
  const applied = validate({ MIGRATION_STATUS: "applied_verified", MIGRATION_IDS: "20260811100000_f08_audit_logs_actor_identity" });
  assert.equal(applied.accepted, true, applied.stderr);
});

test("every claim variable is required, so an unset one cannot default to green", () => {
  // The old failure mode: absent variables were "enforced" by a KeyError in the
  // evidence writer, which runs after the service has already been restarted.
  assertRejected({ CI_RUN_ID: undefined }, /CI_RUN_ID is required/);
  assertRejected({ CI_RUN_URL: undefined }, /CI_RUN_URL is required/);
  assertRejected({ CI_HEAD_SHA: undefined }, /CI_HEAD_SHA is required/);
  assertRejected({ CI_CONCLUSION: undefined }, /CI_CONCLUSION is required/);
  assertRejected({ CI_EVENT: undefined }, /CI_EVENT is required/);
  assertRejected({ CI_WORKFLOW_ID: undefined }, /CI_WORKFLOW_ID is required/);
  assertRejected({ CI_WORKFLOW_PATH: undefined }, /CI_WORKFLOW_PATH is required/);
  assertRejected({ CI_RUN_COMPLETED_AT: undefined }, /CI_RUN_COMPLETED_AT is required/);
  assertRejected({ CI_GATE_AUDIT_SHA256: undefined }, /CI_GATE_AUDIT_SHA256 is required/);
  assertRejected({ CI_GATE_AUDITED_AT: undefined }, /CI_GATE_AUDITED_AT is required/);
  assertRejected({ CI_GATE_AUDIT_RECORD: undefined }, /CI_GATE_AUDIT_RECORD is required/);
  assertRejected({ CI_MAX_RUN_AGE_SECONDS: undefined }, /CI_MAX_RUN_AGE_SECONDS is required/);
  assertRejected({ MIGRATION_STATUS: undefined }, /MIGRATION_STATUS is required/);

  // Empty is the same as unset: `deploy.sh` passes the environment straight
  // through, and an exported-but-empty variable is the common shape of that bug.
  assertRejected({ CI_RUN_ID: "" }, /CI_RUN_ID is required/);
  assertRejected({ CI_CONCLUSION: "" }, /CI_CONCLUSION is required/);
  assertRejected({ CI_EVENT: "" }, /CI_EVENT is required/);
});

test("the immutable layer requires the canonical workflow and well-formed audit binding", () => {
  assertRejected({ CI_WORKFLOW_ID: "999" }, /CI_WORKFLOW_ID must identify the canonical/);
  assertRejected({ CI_WORKFLOW_PATH: ".github/workflows/lookalike.yml" }, /CI_WORKFLOW_PATH must identify the canonical/);
  assertRejected({ CI_RUN_COMPLETED_AT: "not-a-time" }, /CI_RUN_COMPLETED_AT must be a UTC RFC3339/);
  assertRejected({ CI_GATE_AUDITED_AT: "2030-01-01" }, /CI_GATE_AUDITED_AT must be a UTC RFC3339/);
  assertRejected({ CI_GATE_AUDIT_SHA256: "a".repeat(63) }, /CI_GATE_AUDIT_SHA256 must be a lowercase SHA-256/);
  assertRejected({ CI_GATE_AUDIT_RECORD: "/tmp/audit.json" }, /CI_GATE_AUDIT_RECORD must use the canonical/);
  assertRejected({ CI_MAX_RUN_AGE_SECONDS: "86401" }, /CI_MAX_RUN_AGE_SECONDS must be between/);
});

test("the claim must be about the commit being deployed", () => {
  // This is the check whose absence made every other one decorative:
  // CI_CONCLUSION=success CI_HEAD_SHA=$(git rev-parse HEAD~20) produced a fully
  // green permanent record for a release whose CI had never run.
  assertRejected({ CI_HEAD_SHA: OTHER_SHA }, /does not match the release SHA/);
  assertRejected({ CI_HEAD_SHA: RELEASE_SHA.slice(0, 39) }, /does not match the release SHA/);
  assertRejected({ CI_HEAD_SHA: RELEASE_SHA.toUpperCase() }, /does not match the release SHA/);
});

test("a non-success conclusion is rejected", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "neutral", "skipped", "action_required", "SUCCESS", "success ", "manual_verified"]) {
    assertRejected({ CI_CONCLUSION: conclusion }, /CI_CONCLUSION must be 'success'/);
  }
});

test("only the event that can run the full gate set is accepted", () => {
  // A pull_request run tests the merge commit and skips release-candidate jobs;
  // workflow_run/schedule/repository_dispatch prove nothing about this SHA. And
  // `push` — accepted by this function until this revision — cannot contain the
  // manual candidate gate set at all, so it cannot satisfy the required set the
  // wrapper measures.
  for (const event of ["push", "pull_request", "pull_request_target", "workflow_run", "schedule", "repository_dispatch", "merge_group", "release", ""]) {
    assertRejected({ CI_EVENT: event }, /CI_EVENT (must be 'workflow_dispatch'|is required)/);
  }
  assert.equal(validate({ CI_EVENT: "workflow_dispatch" }).accepted, true);
});

test("the archived run URL cannot point at a different run than the claim", () => {
  const other = "29351813435";
  assertRejected(
    { CI_RUN_URL: `https://github.com/69755354/newme-platform/actions/runs/${other}` },
    /CI_RUN_URL must be the github.com actions run URL/,
  );
  // Host and path shape matter: an attacker-controlled or look-alike host would
  // otherwise be archived as the audit link for this release.
  for (const url of [
    `https://github.com.evil.example/69755354/newme-platform/actions/runs/${RUN_ID}`,
    `http://github.com/69755354/newme-platform/actions/runs/${RUN_ID}`,
    `https://github.com/69755354/newme-platform/actions/runs/${RUN_ID}/attempts/2`,
    `https://github.com/69755354/newme-platform/actions/runs/${RUN_ID}x`,
    `https://evil.example/69755354/newme-platform/actions/runs/${RUN_ID}`,
    "not a url",
  ]) {
    assertRejected({ CI_RUN_URL: url }, /CI_RUN_URL must be the github.com actions run URL/);
  }
  // The one extra shape GitHub itself produces (a deep link to a job) is fine.
  assert.equal(
    validate({ CI_RUN_URL: `https://github.com/69755354/newme-platform/actions/runs/${RUN_ID}/job/82412345678` }).accepted,
    true,
  );
});

test("a run id that is not a GitHub run id is rejected", () => {
  for (const runId of ["manual", "29351813434 ", "-1", "1e5", "0x1f", "abc"]) {
    assertRejected({ CI_RUN_ID: runId }, /CI_RUN_ID must be a numeric GitHub run id|CI_RUN_URL must be/);
  }
});

test("migration claims must be internally consistent", () => {
  // The original bug: MIGRATION_STATUS=applied with no ids was recorded as a
  // verified migration. "applied" is not even a value either layer accepts now.
  assertRejected({ MIGRATION_STATUS: "applied" }, /MIGRATION_STATUS must be 'applied_verified', 'reentry_verified' or 'not_required'/);
  assertRejected({ MIGRATION_STATUS: "pending" }, /MIGRATION_STATUS must be 'applied_verified', 'reentry_verified' or 'not_required'/);
  assertRejected({ MIGRATION_STATUS: "skipped" }, /MIGRATION_STATUS must be 'applied_verified', 'reentry_verified' or 'not_required'/);

  assertRejected(
    { MIGRATION_STATUS: "applied_verified", MIGRATION_IDS: "" },
    /applied_verified requires MIGRATION_IDS/,
  );
  assertRejected(
    { MIGRATION_STATUS: "applied_verified", MIGRATION_IDS: undefined },
    /applied_verified requires MIGRATION_IDS/,
  );
  // A "not_required" claim that nevertheless names migrations is a claim about
  // two different releases; refuse to archive it as either.
  assertRejected(
    { MIGRATION_STATUS: "not_required", MIGRATION_IDS: "20260811100000_f08_audit_logs_actor_identity" },
    /not_required must not carry MIGRATION_IDS/,
  );
  // Ids are copied into a JSON evidence record and a journal entry.
  for (const ids of ['a"b', "a;b", "a b", "a,,b", ",a", "a,", "$(id)", "a\nb"]) {
    assertRejected(
      { MIGRATION_STATUS: "applied_verified", MIGRATION_IDS: ids },
      /MIGRATION_IDS must be a comma-separated list/,
    );
  }
  assert.equal(
    validate({ MIGRATION_STATUS: "applied_verified", MIGRATION_IDS: "20260811100000_f08,20260811100100_f06" }).accepted,
    true,
  );
  assertRejected(
    { MIGRATION_STATUS: "reentry_verified", MIGRATION_IDS: "" },
    /reentry_verified requires MIGRATION_IDS/,
  );
  assert.equal(
    validate({ MIGRATION_STATUS: "reentry_verified", MIGRATION_IDS: "20260811100000_f08,20260811100100_f06" }).accepted,
    true,
  );
});

test("the manual-verification claim shape cannot bypass this layer", () => {
  // scripts/verify-release-preflight.sh still has a NEWME_MANUAL_VERIFICATION=1
  // branch that accepts CI_RUN_ID=manual / CI_CONCLUSION=manual_verified. That
  // branch is reachable only through deploy-immutable.sh, which runs this
  // function first — so the human-attested bypass is closed at the layer that
  // writes the evidence, whatever the environment claims.
  assertRejected(
    { CI_RUN_ID: "manual", CI_RUN_URL: "manual", CI_CONCLUSION: "manual_verified" },
    /CI_RUN_ID must be a numeric GitHub run id/,
  );
});

test("the guard runs before the deploy touches anything", () => {
  const script = readFileSync(DEPLOY, "utf8");
  const lines = script.split(/\r?\n/);
  const callIndex = lines.findIndex((line) => /^validate_release_claims \|\|/.test(line));
  assert.notEqual(callIndex, -1, "validate_release_claims must be called at top level");

  // Rejecting a claim must cost nothing: no staging directory, no symlink, no
  // service action, no asset backup may precede it. Function *definitions* are
  // allowed above the call; their bodies only run later.
  const definitionDepth = [];
  for (let i = 0; i < callIndex; i += 1) {
    const line = lines[i];
    if (/^[a-z_]+\(\) \{/.test(line)) definitionDepth.push(i);
    if (line === "}") definitionDepth.pop();
    if (definitionDepth.length > 0) continue;
    assert.doesNotMatch(
      line,
      /^\s*(mkdir|install -d|ln -s|rm -rf|cp -a|rsync|tar |git -C .* archive|"\$CONTROL"|systemctl)\b/,
      `line ${i + 1} mutates state before the release claim is validated: ${line}`,
    );
  }

  // exit 64, not a warning: the claim is the only evidence this layer has.
  assert.match(lines[callIndex], /exit 64/);
});

/**
 * The wrapper's re-measurement of the claim, lifted out and run against fixture
 * API payloads. It is an inline python3 program; running it is the only way to
 * know what it checks, because a regex over shell text cannot tell a check from a
 * comment about a check.
 */
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, "infra/release/required-jobs.json"), "utf8"));
const FIXTURE_NOW = Date.now();
const fixtureTime = (millisecondsAgo) => new Date(FIXTURE_NOW - millisecondsAgo).toISOString();
const GOOD_WORKFLOW = {
  id: MANIFEST.workflow_id,
  path: MANIFEST.workflow_path,
  name: MANIFEST.workflow,
  state: "active",
};

function wrapperCheck() {
  const wrapper = readFileSync(WRAPPER, "utf8");
  const start = wrapper.indexOf("python3 -c '");
  assert.notEqual(start, -1, "the wrapper no longer verifies the run via the GitHub API");
  const body = wrapper.slice(start + "python3 -c '".length);
  const program = body.slice(0, body.indexOf("\n' "));
  assert.ok(program.includes("json.loads"), "extracted the wrong block from the wrapper");
  const programFile = path.join(TMP, "wrapper-check.py");
  writeFileSync(programFile, program);
  return (run, jobs, manifest = MANIFEST, workflow = GOOD_WORKFLOW) =>
    spawnSync(
      "python3",
      [
        programFile,
        RELEASE_SHA,
        RUN_ID,
        JSON.stringify(run),
        JSON.stringify(jobs),
        JSON.stringify(workflow),
        JSON.stringify(manifest),
      ],
      { encoding: "utf8" },
    );
}

const GOOD_RUN = {
  id: Number(RUN_ID),
  head_sha: RELEASE_SHA,
  name: "ci",
  path: MANIFEST.workflow_path,
  workflow_id: MANIFEST.workflow_id,
  status: "completed",
  conclusion: "success",
  event: "workflow_dispatch",
  head_branch: "main",
  created_at: fixtureTime(180_000),
  run_started_at: fixtureTime(120_000),
  updated_at: fixtureTime(60_000),
};

/** The job list a release-candidate dispatch of ci actually produces. */
function jobList(overrides = []) {
  const jobs = MANIFEST.required_jobs.map((entry) => ({
    name: entry.name,
    status: "completed",
    conclusion: "success",
    head_sha: RELEASE_SHA,
    started_at: fixtureTime(110_000),
    completed_at: fixtureTime(70_000),
  }));
  for (const override of overrides) {
    const index = jobs.findIndex((job) => job.name === override.name);
    if (index === -1) jobs.push(override);
    else if (override.drop) jobs.splice(index, 1);
    else jobs[index] = { ...jobs[index], ...override };
  }
  return { total_count: jobs.length, jobs };
}

test("the wrapper requires a release-candidate main dispatch of ci", () => {
  const check = wrapperCheck();
  const status = (run, jobs = jobList()) => check(run, jobs).status;

  assert.equal(status(GOOD_RUN), 0, check(GOOD_RUN).stderr);

  // Each of these was accepted before: the check looked at id, head_sha, name and
  // conclusion only, so a green pull_request run on any topic branch passed.
  assert.equal(status({ ...GOOD_RUN, event: "pull_request" }), 65, "a pull_request run skips candidate-only jobs");
  assert.equal(status({ ...GOOD_RUN, event: "push" }), 65, "a push run cannot contain candidate-only jobs");
  assert.equal(status({ ...GOOD_RUN, event: "workflow_run" }), 65);
  assert.equal(status({ ...GOOD_RUN, event: "schedule" }), 65);
  assert.equal(status({ ...GOOD_RUN, head_branch: "agent/prod-l0-taskboard-closure" }), 65, "a topic-branch run is not main evidence");
  assert.equal(status({ ...GOOD_RUN, conclusion: "failure" }), 65);
  assert.equal(status({ ...GOOD_RUN, conclusion: null }), 65, "an in-progress run has no conclusion");
  assert.equal(status({ ...GOOD_RUN, status: "in_progress" }), 65);
  assert.equal(status({ ...GOOD_RUN, head_sha: OTHER_SHA }), 65);
  assert.equal(status({ ...GOOD_RUN, name: "crm-ci" }), 65, "a different workflow is a different gate set");
  assert.equal(status({ ...GOOD_RUN, id: 1 }), 65, "the run must be the one named in the claim");
  assert.equal(status({}), 65, "a payload missing every field must not be accepted");
});

test("the wrapper requires every job in the release manifest to have concluded success", () => {
  const check = wrapperCheck();

  // The whole point of the change: a run can be green with a required job absent
  // or skipped, because a skipped job does not make a run anything but green.
  for (const name of MANIFEST.required_jobs.map((entry) => entry.name)) {
    const absent = check(GOOD_RUN, jobList([{ name, drop: true }]));
    assert.equal(absent.status, 65, `a run without ${name} was accepted`);
    assert.match(absent.stderr, new RegExp(`required job\\(s\\) absent from the run: ${name}`));

    for (const conclusion of ["skipped", "failure", "cancelled", "timed_out", "neutral", "stale", null]) {
      const bad = check(GOOD_RUN, jobList([{ name, conclusion }]));
      assert.equal(bad.status, 65, `${name} concluding ${conclusion} was accepted`);
    }

    const running = check(GOOD_RUN, jobList([{ name, status: "in_progress", conclusion: null }]));
    assert.equal(running.status, 65);
    assert.match(running.stderr, /has not completed/);
  }
});

test("the wrapper refuses job lists it cannot fully judge", () => {
  const check = wrapperCheck();

  // A paginated list would otherwise be judged on its first page.
  const paginated = jobList();
  paginated.total_count = paginated.jobs.length + 1;
  assert.match(check(GOOD_RUN, paginated).stderr, /paginated/);
  assert.equal(check(GOOD_RUN, paginated).status, 65);

  assert.equal(check(GOOD_RUN, { total_count: 0, jobs: [] }).status, 65);
  assert.equal(check(GOOD_RUN, {}).status, 65);

  // A job from a different commit, and a duplicate required job, are both
  // states where "success" is about something other than this release.
  assert.match(
    check(GOOD_RUN, jobList([{ name: "Repository validation", head_sha: OTHER_SHA }])).stderr,
    /ran against a different commit/,
  );
  const duplicated = jobList();
  duplicated.jobs.push({ ...duplicated.jobs[0], conclusion: "success" });
  duplicated.total_count = duplicated.jobs.length;
  assert.match(check(GOOD_RUN, duplicated).stderr, /appears twice/);

  // A non-required job that failed still means this commit is not green.
  const extra = jobList([{ name: "Some future job", status: "completed", conclusion: "failure", head_sha: RELEASE_SHA }]);
  assert.equal(check(GOOD_RUN, extra).status, 65);
  // ...but one that was skipped by its own `if:` is fine.
  const skippedExtra = jobList([{ name: "Some future job", status: "completed", conclusion: "skipped", head_sha: RELEASE_SHA }]);
  assert.equal(check(GOOD_RUN, skippedExtra).status, 0, check(GOOD_RUN, skippedExtra).stderr);
});

test("the wrapper refuses a manifest that has been emptied or loosened", () => {
  const check = wrapperCheck();

  // The manifest is read from the release mirror at the SHA being deployed, so
  // this is the shape of "someone shipped a commit that turns the gate off".
  assert.equal(check(GOOD_RUN, jobList(), { ...MANIFEST, required_jobs: [] }).status, 65);
  assert.equal(check(GOOD_RUN, jobList(), { ...MANIFEST, required_jobs: [{ why: "no name" }] }).status, 65);
  assert.equal(
    check(GOOD_RUN, jobList(), { ...MANIFEST, tolerated_conclusions: ["success", "skipped"] }).status,
    65,
    "a manifest that tolerates skipped required jobs must be refused",
  );
  const duplicatedRequirement = {
    ...MANIFEST,
    required_jobs: [...MANIFEST.required_jobs, MANIFEST.required_jobs[0]],
  };
  assert.equal(check(GOOD_RUN, jobList(), duplicatedRequirement).status, 65);
});

test("the wrapper enforces the predeploy taskboard scope and remote migration history before it stages anything", () => {
  // Two claims CI structurally cannot make about production: that the board's
  // pre-deploy milestone is closed in the tree being deployed, and that
  // production's recorded migration history is the history this release contains.
  // Both were unenforced in the canonical path — scripts/deploy.sh checked the
  // board, and scripts/deploy.sh is not the canonical path.
  const wrapper = readFileSync(WRAPPER, "utf8");
  const lines = wrapper.split(/\r?\n/);
  const at = (pattern) => lines.findIndex((line) => pattern.test(line));

  // Round-4 C4-4. The milestone, not the whole board: --require-complete could
  // never pass here because most rows on that board close only once production has
  // run the release, and a gate that cannot pass is a gate that gets routed
  // around. The scope is still fail-closed — an undeclared unfinished row FAILs
  // the checker and is counted in predeploy_ready — and release-final completeness
  // stays with the separate closure workflow.
  const taskboard = at(/check-taskboard\.mjs" --require-scope=predeploy_ready/);
  const remoteHistory = at(/verify-remote-migration-history\.mjs/);
  // Select the ordinary asset transaction, not the earlier credential-only
  // coordinator branch, which deliberately has its own narrower gates.
  const assets = at(/^\s*bash "\$WORKTREE\/scripts\/install-systemd-assets\.sh"$/);
  const immutable = at(/deploy-immutable\.sh" "\$SHA"/);

  assert.notEqual(taskboard, -1, "the wrapper does not require the predeploy taskboard scope");
  assert.equal(
    at(/check-taskboard\.mjs" --require-complete/),
    -1,
    "the wrapper must not require a milestone this deployment is itself the precondition of",
  );
  assert.notEqual(remoteHistory, -1, "the wrapper does not verify the remote migration history");
  assert.ok(taskboard < assets, "the taskboard gate must run before assets are installed");
  assert.ok(remoteHistory < assets, "the history gate must run before assets are installed");
  assert.ok(assets < immutable);

  // Both abort, and abort with the wrapper's precondition status.
  assert.match(wrapper, /TASKBOARD\.md at canonical main is not predeploy-ready; production operation is blocked" >&2\n\s*return 65/);
  assert.match(wrapper, /production migration history does not match the release being deployed" >&2\n\s*exit 65/);

  // The connection string is a credential: root-owned, not group- or
  // world-readable, and handed over as a path, never as a value.
  assert.match(wrapper, /MIGRATION_DB_URL_FILE=\/etc\/newme\/migration-db\.url/);
  assert.match(wrapper, /stat -c '%U:%G' "\$MIGRATION_DB_URL_FILE"\)" = root:root/);
  assert.match(wrapper, /migration database URL file mode must be 0400 or 0600/);
  assert.match(wrapper, /--url-file "\$MIGRATION_DB_URL_FILE"/);
  assert.doesNotMatch(wrapper, /--url[= ]postgres/);

  // The claim on the command line decides which direction is re-measured, so a
  // not_required deployment cannot quietly carry unapplied migrations. What is
  // re-measured for applied_verified is the set derived from the release's own
  // manifest, never the operator's list — see
  // tests/release/release-claim-derivation.test.mjs for the finding (round-4 C4-1)
  // and for the derivation itself.
  assert.match(wrapper, /MIGRATION_HISTORY_ARGS\+=\(--require-applied "\$REQUIRED_IDS"\)/);
  assert.match(wrapper, /MIGRATION_HISTORY_ARGS\+=\(--require-applied "\$REQUIRED_IDS,\$DEFERRED_IDS"\)/);
  assert.doesNotMatch(wrapper, /--require-applied "\$MIGRATION_IDS"/);
  assert.match(wrapper, /not_required\)\s+MIGRATION_HISTORY_ARGS\+=\(--require-no-pending\)/);

  // The required-jobs manifest comes from the mirror at the SHA being deployed,
  // not from anywhere on the host.
  assert.match(wrapper, /git --git-dir="\$MIRROR" show \\\n\s*"\$MAIN_SHA:infra\/release\/required-jobs\.json"/);
  assert.match(wrapper, /main does not carry infra\/release\/required-jobs\.json/);
});

test("every required job exists in ci.yml and can run on a release-candidate dispatch", () => {
  // A manifest naming a job that does not exist would be unsatisfiable — the
  // exact defect this replaces, in a new place.
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const lines = ci.split(/\r?\n/);

  for (const { name } of MANIFEST.required_jobs) {
    const index = lines.findIndex((line) => line.trim() === `name: ${name}`);
    assert.notEqual(index, -1, `ci.yml has no job named "${name}"`);
    // The `if:` belonging to this job, if any, sits in the lines that follow its
    // name until the next job's two-space key.
    let condition = "";
    for (let i = index + 1; i < lines.length; i += 1) {
      if (/^ {2}\S/.test(lines[i])) break;
      const match = /^\s{4}if:\s*(.*)$/.exec(lines[i]);
      if (match) condition = match[1];
    }
    if (condition) {
      assert.match(
        condition,
        /workflow_dispatch/,
        `"${name}" is gated on ${condition}, which a release-candidate dispatch cannot satisfy`,
      );
    }
  }

  const finalJob = lines.findIndex((line) => line.trim() === "name: Release-final taskboard completion");
  assert.match(lines[finalJob + 1], /if: .*workflow_dispatch.*inputs\.release_final/);
  assert.ok(!MANIFEST.required_jobs.some((job) => job.name === "Release-final taskboard completion"));
  assert.ok(MANIFEST.required_jobs.some((job) => job.name === "Predeploy taskboard readiness"));
});
