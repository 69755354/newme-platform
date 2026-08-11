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
 * The wrapper's own GitHub-API event check is exercised the same way, because the
 * two layers must agree about what a valid claim looks like: a `pull_request` run
 * of the ci workflow is green with a strictly smaller set of jobs than a main
 * push (the release-final jobs are gated on the event), so accepting one records
 * an incomplete gate set as a complete one.
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
  CI_EVENT: "push",
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

  const result = spawnSync("bash", [harness], { encoding: "utf8", env });
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

  // applied_verified is the other accepted shape, and it must carry ids.
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
  assertRejected({ MIGRATION_STATUS: undefined }, /MIGRATION_STATUS is required/);

  // Empty is the same as unset: `deploy.sh` passes the environment straight
  // through, and an exported-but-empty variable is the common shape of that bug.
  assertRejected({ CI_RUN_ID: "" }, /CI_RUN_ID is required/);
  assertRejected({ CI_CONCLUSION: "" }, /CI_CONCLUSION is required/);
  assertRejected({ CI_EVENT: "" }, /CI_EVENT is required/);
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

test("only events that run the full gate set are accepted", () => {
  // A pull_request run tests the merge commit and skips the release-final jobs;
  // workflow_run/schedule/repository_dispatch prove nothing about this SHA.
  for (const event of ["pull_request", "pull_request_target", "workflow_run", "schedule", "repository_dispatch", "merge_group", "release", ""]) {
    assertRejected({ CI_EVENT: event }, /CI_EVENT (must be 'push' or 'workflow_dispatch'|is required)/);
  }
  for (const event of ["push", "workflow_dispatch"]) {
    assert.equal(validate({ CI_EVENT: event }).accepted, true, `${event} must be accepted`);
  }
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
  assertRejected({ MIGRATION_STATUS: "applied" }, /MIGRATION_STATUS must be 'applied_verified' or 'not_required'/);
  assertRejected({ MIGRATION_STATUS: "pending" }, /MIGRATION_STATUS must be 'applied_verified' or 'not_required'/);
  assertRejected({ MIGRATION_STATUS: "skipped" }, /MIGRATION_STATUS must be 'applied_verified' or 'not_required'/);

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

test("the wrapper's GitHub-API check requires a successful main-branch push of ci", () => {
  // The wrapper is the layer that can actually re-measure the claim. Its check is
  // an inline python3 program; run it with fixture payloads instead of trusting
  // that the comment above it describes what it does.
  const wrapper = readFileSync(WRAPPER, "utf8");
  const start = wrapper.indexOf("python3 -c '");
  assert.notEqual(start, -1, "the wrapper no longer verifies the run via the GitHub API");
  const body = wrapper.slice(start + "python3 -c '".length);
  const program = body.slice(0, body.indexOf("\n' "));
  assert.ok(program.includes("json.loads"), "extracted the wrong block from the wrapper");

  const programFile = path.join(TMP, "wrapper-check.py");
  writeFileSync(programFile, program);

  const good = {
    id: Number(RUN_ID),
    head_sha: RELEASE_SHA,
    name: "ci",
    conclusion: "success",
    event: "push",
    head_branch: "main",
  };
  const check = (run) =>
    spawnSync("python3", [programFile, RELEASE_SHA, RUN_ID, JSON.stringify(run)], { encoding: "utf8" }).status;

  assert.equal(check(good), 0, "a successful main-branch push run of ci must be accepted");

  // Each of these was accepted before: the check looked at id, head_sha, name and
  // conclusion only, so a green pull_request run on any topic branch passed.
  assert.equal(check({ ...good, event: "pull_request" }), 65, "a pull_request run skips the release-final jobs");
  assert.equal(check({ ...good, event: "workflow_run" }), 65);
  assert.equal(check({ ...good, event: "schedule" }), 65);
  assert.equal(check({ ...good, head_branch: "agent/prod-l0-taskboard-closure" }), 65, "a topic-branch run is not main evidence");
  assert.equal(check({ ...good, conclusion: "failure" }), 65);
  assert.equal(check({ ...good, conclusion: null }), 65, "an in-progress run has no conclusion");
  assert.equal(check({ ...good, head_sha: OTHER_SHA }), 65);
  assert.equal(check({ ...good, name: "crm-ci" }), 65, "a different workflow is a different gate set");
  assert.equal(check({ ...good, id: 1 }), 65, "the run must be the one named in the claim");
  assert.equal(check({}), 65, "a payload missing every field must not be accepted");
});
