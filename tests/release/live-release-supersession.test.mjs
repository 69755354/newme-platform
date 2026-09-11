/**
 * The deploy wrapper's live-release precondition, executed rather than read.
 *
 * The defect: `release_status == "complete"` was required of the release that is
 * live before another one could be deployed, and `complete` is written only by
 * `newme-deploy finalize`, which refuses unless the closure commit is the single
 * direct child of the release SHA changing nothing but TASKBOARD.md. main is
 * append-only, so one unrelated commit after a release permanently destroys that
 * release's only closure slot -- and from that moment the precondition can never
 * be met by anything, so every future production deployment is refused. Two
 * separately reasonable contracts (a single-slot closure, and a 45-day provenance
 * expiry that made a pull request the only way to keep main mergeable) combined
 * into a frozen control plane on 2026-09-11.
 *
 * These tests EXECUTE verify_live_release_permits_new_release(), lifted verbatim
 * out of infra/systemd/newme-deploy.sh, against real temporary repositories. A
 * regex over shell text cannot tell a check from a comment about a check, and the
 * whole point of this change is which of two indistinguishable states the wrapper
 * is looking at -- so the states are built for real and the function is asked.
 *
 * The controls that matter are the refusals. If "the closure is still reachable"
 * stopped being refused, the original operator error (deploying over a release
 * whose taskboard closure was merely forgotten) would silently return; if
 * `awaiting_uat` stopped being refused, a release with no production acceptance
 * at all could be buried. Both are asserted below alongside the acceptance case.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WRAPPER = path.join(ROOT, "infra/systemd/newme-deploy.sh");
const FUNCTION_NAME = "verify_live_release_permits_new_release";

/**
 * Lift a top-level shell function whose body is a subshell -- `name() (` ... `)`
 * with the closing parenthesis at column 0. The wrapper uses the subshell form for
 * every function that sets its own shell options, and copying the body by hand
 * here would be a second copy of the boundary under test.
 */
function extractSubshellFunction(file, name) {
  const lines = readFileSync(file, "utf8").replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => line === `${name}() (`);
  assert.notEqual(start, -1, `${path.basename(file)} no longer defines ${name}() as a subshell function`);
  const end = lines.indexOf(")", start);
  assert.notEqual(end, -1, `${name}() has no closing parenthesis at column 0`);
  return lines.slice(start, end + 1).join("\n");
}

const FUNCTION = extractSubshellFunction(WRAPPER, FUNCTION_NAME);
const TMP = mkdtempSync(path.join(tmpdir(), "newme-live-release-"));

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "gate",
      GIT_AUTHOR_EMAIL: "gate@example.invalid",
      GIT_COMMITTER_NAME: "gate",
      GIT_COMMITTER_EMAIL: "gate@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(work, message, files) {
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(work, name), contents);
  }
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", message);
  return git(work, "rev-parse", "HEAD");
}

/**
 * One repository holding every shape the function has to tell apart:
 *
 *   base ── live ── closure            TASKBOARD.md only, one commit   (reachable)
 *             │  └─ source            a source path                   (consumed)
 *             │  └─ taskboardTwice    TASKBOARD.md only, two commits  (consumed)
 *             └─ (from base) sibling  does not contain live
 */
function buildRepository() {
  const work = path.join(TMP, "repo");
  mkdirSync(work, { recursive: true });
  git(work, "init", "--quiet", "--initial-branch=main", ".");
  const base = commit(work, "base", { "TASKBOARD.md": "board v1\n", "src.txt": "code v1\n" });
  const live = commit(work, "live release", { "src.txt": "code v2\n" });

  git(work, "checkout", "--quiet", "-b", "closure", live);
  const closure = commit(work, "closure", { "TASKBOARD.md": "board v1\n<!-- marker -->\n" });

  git(work, "checkout", "--quiet", "-b", "source", live);
  const source = commit(work, "candidate with a source change", { "src.txt": "code v3\n" });

  git(work, "checkout", "--quiet", "-b", "taskboardTwice", live);
  commit(work, "closure attempt", { "TASKBOARD.md": "board v1\n<!-- marker -->\n" });
  const taskboardTwice = commit(work, "second taskboard commit", { "TASKBOARD.md": "board v1\n<!-- marker -->\n<!-- again -->\n" });

  git(work, "checkout", "--quiet", "-b", "sibling", base);
  const sibling = commit(work, "unrelated line of history", { "src.txt": "code v9\n" });

  return { mirror: path.join(work, ".git"), base, live, closure, source, taskboardTwice, sibling };
}

const REPO = buildRepository();

function evidence(name, body) {
  const file = path.join(TMP, `${name}.json`);
  writeFileSync(file, JSON.stringify(body));
  return file;
}

/** Run the lifted function with the wrapper's own argument order. */
function ask({ status, live = REPO.live, candidate = REPO.source, dbTransition = "0", operation = "", gitSha }) {
  const file = evidence(`${status}-${Math.random().toString(36).slice(2)}`, {
    git_sha: gitSha === undefined ? live : gitSha,
    release_status: status,
  });
  const script = path.join(TMP, "run.sh");
  writeFileSync(
    script,
    `${FUNCTION}\n${FUNCTION_NAME} "$1" "$2" "$3" "$4" "$5" "$6"\n`,
  );
  const result = spawnSync("bash", [script, file, live, candidate, dbTransition, operation, REPO.mirror], {
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("a completed live release still permits the next deployment", () => {
  const result = ask({ status: "complete" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "", "a completed release is the ordinary case and claims nothing");
});

test("an attested live release whose closure slot was consumed is superseded, and says so", () => {
  const result = ask({ status: "acceptance_verified", candidate: REPO.source });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^superseded_release=${REPO.live} `));
  assert.match(result.stdout, /superseded_status=acceptance_verified closure_slot=consumed commits_since=1$/m);
});

test("a taskboard-only closure that is no longer the single child is also consumed", () => {
  const result = ask({ status: "acceptance_verified", candidate: REPO.taskboardTwice });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /closure_slot=consumed commits_since=2$/m);
});

test("CONTROL: a still-reachable closure is refused, because that is the forgotten-finalize error", () => {
  const result = ask({ status: "acceptance_verified", candidate: REPO.closure });
  assert.equal(result.code, 65);
  assert.match(result.stderr, /closure commit is still reachable; finalize it instead of deploying/);
  assert.equal(result.stdout, "");
});

test("CONTROL: a live release that was never attested is refused and pointed at release recovery", () => {
  for (const status of ["awaiting_uat", "uat_failed", "unknown_status"]) {
    const result = ask({ status, candidate: REPO.source });
    assert.equal(result.code, 65, `${status} must not be supersedable`);
    assert.match(result.stderr, /never attested, so it cannot be superseded/);
    assert.match(result.stderr, /newme-production-rollback execute/);
  }
});

test("CONTROL: evidence for a different release, a divergent candidate, or the live SHA itself is refused", () => {
  assert.equal(ask({ status: "complete", gitSha: "f".repeat(40) }).code, 65);
  const divergent = ask({ status: "acceptance_verified", candidate: REPO.sibling });
  assert.equal(divergent.code, 65);
  assert.match(divergent.stderr, /candidate does not contain the live release/);
  const itself = ask({ status: "acceptance_verified", candidate: REPO.live });
  assert.equal(itself.code, 65);
  assert.match(itself.stderr, /candidate is the live release/);
});

test("a contract transition keeps its own status set and must name the live release", () => {
  for (const operation of ["contract-apply", "contract-verify", "contract-rollback", "contract-reenter"]) {
    for (const status of ["awaiting_uat", "acceptance_verified", "complete"]) {
      const allowed = ask({ status, candidate: REPO.live, dbTransition: "1", operation });
      assert.equal(allowed.code, 0, `${operation} on ${status}: ${allowed.stderr}`);
    }
    const wrongTarget = ask({ status: "complete", candidate: REPO.source, dbTransition: "1", operation });
    assert.equal(wrongTarget.code, 65);
    assert.match(wrongTarget.stderr, /contract transition must name the live release/);
    const wrongStatus = ask({ status: "uat_failed", candidate: REPO.live, dbTransition: "1", operation });
    assert.equal(wrongStatus.code, 65);
    assert.match(wrongStatus.stderr, /does not permit a contract transition/);
  }
});

test("an expand transition is not a contract transition and gets the ordinary release rule", () => {
  for (const operation of ["expand-plan", "expand-apply"]) {
    const attested = ask({ status: "acceptance_verified", candidate: REPO.source, dbTransition: "1", operation });
    assert.equal(attested.code, 0, attested.stderr);
    const unattested = ask({ status: "awaiting_uat", candidate: REPO.source, dbTransition: "1", operation });
    assert.equal(unattested.code, 65);
  }
});

test("the deploy preamble calls the function it defines, and keeps no second copy of the rule", () => {
  const wrapper = readFileSync(WRAPPER, "utf8").replaceAll("\r\n", "\n");
  assert.equal(wrapper.split(`${FUNCTION_NAME}() (`).length - 1, 1, "the function is defined once");
  const definition = wrapper.indexOf(`${FUNCTION_NAME}() (`);
  const call = wrapper.indexOf(`  ${FUNCTION_NAME} \\`);
  assert.ok(call > definition, "the call site must follow the definition");
  assert.match(
    wrapper.slice(call),
    /^ {2}verify_live_release_permits_new_release \\\n {4}"\$\{CURRENT_EVIDENCE_FILES\[0\]\}" "\$ROLLBACK_SHA" "\$SHA" \\\n {4}"\$DB_TRANSITION_ONLY" "\$DB_TRANSITION_OPERATION" "\$MIRROR" \|\| exit \$\?\n/,
  );
  assert.doesNotMatch(wrapper, /elif release_status != "complete":/, "the inline copy of the rule is gone");
});
