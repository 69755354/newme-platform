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

import { isClosureDriftAllowedPath } from "../../scripts/check-release-closure.mjs";

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

const PATH_RULE_NAME = "closure_drift_path_allowed";
const REACHABLE_NAME = "live_release_closure_reachable";
const CHECKER_ARGS_NAME = "finalize_final_sha_checker_args";
const EVIDENCE_ARGS_NAME = "finalize_final_sha_evidence_args";
const NEW_CHECKER = readFileSync(path.join(ROOT, "scripts/check-release-closure.mjs"), "utf8");
// A checker from before the final-run SHA existed: it has no --final-sha flag.
const OLD_CHECKER = "// legacy release-closure checker: --release-sha --closure-sha --acceptance-digest only\n";
const DIGEST = "a".repeat(64);
const MARKER = `<!-- postdeploy-acceptance-sha256:${DIGEST} -->`;
// The supersession function calls two helpers defined just above it; lift all
// three so the executed rule is exactly the wrapper's.
const FUNCTION = [
  extractSubshellFunction(WRAPPER, PATH_RULE_NAME),
  extractSubshellFunction(WRAPPER, REACHABLE_NAME),
  extractSubshellFunction(WRAPPER, FUNCTION_NAME),
].join("\n");
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
    mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
    writeFileSync(path.join(work, name), contents);
  }
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", message);
  return git(work, "rev-parse", "HEAD");
}

/**
 * One repository holding every shape the function has to tell apart. `live`
 * ships the current checker (knows --final-sha); `liveOld` ships a checker from
 * before the final-run SHA existed.
 *
 *   base ── live ── closure              TASKBOARD.md only, one commit        (reachable)
 *             │       ├─ closureThenDocs  then docs/, .claude/, CLAUDE.md,    (reachable)
 *             │       │                   a Chinese docs path, TASKBOARD.md
 *             │       ├─ closureThenSrc   then docs/ then a source path       (consumed)
 *             │       ├─ closureThenInfra then infra/ (.github/ likewise)     (consumed)
 *             │       ├─ closureThenMerge then a merge of two docs commits    (consumed)
 *             │       └─ markerErased     then TASKBOARD.md loses the marker  (consumed, noted)
 *             │  └─ source               a source path                       (consumed)
 *             │  └─ taskboardTwice       TASKBOARD.md only, two commits       (reachable)
 *             │  └─ docsFirst            docs/ first, TASKBOARD.md second     (consumed)
 *             │  └─ fakeMarker           closure adds no real marker          (consumed, noted)
 *             └─ (from base) sibling     does not contain live
 *   base ── liveOld ── oldClosure        TASKBOARD.md only, one commit        (reachable)
 *                        └─ oldThenDocs   then docs/ only                     (consumed, noted)
 */
function buildRepository() {
  const work = path.join(TMP, "repo");
  mkdirSync(work, { recursive: true });
  git(work, "init", "--quiet", "--initial-branch=main", ".");
  const base = commit(work, "base", {
    "TASKBOARD.md": "board v1\n",
    "src.txt": "code v1\n",
    "scripts/check-release-closure.mjs": NEW_CHECKER,
  });
  const live = commit(work, "live release", { "src.txt": "code v2\n" });

  git(work, "checkout", "--quiet", "-b", "closure", live);
  const closure = commit(work, "closure", { "TASKBOARD.md": `board v1\n${MARKER}\n` });

  git(work, "checkout", "--quiet", "-b", "source", live);
  const source = commit(work, "candidate with a source change", { "src.txt": "code v3\n" });

  git(work, "checkout", "--quiet", "-b", "taskboardTwice", live);
  commit(work, "closure attempt", { "TASKBOARD.md": `board v1\n${MARKER}\n` });
  const taskboardTwice = commit(work, "second taskboard commit", { "TASKBOARD.md": `board v1\n${MARKER}\n<!-- again -->\n` });

  git(work, "checkout", "--quiet", "-b", "docsFirst", live);
  commit(work, "docs before the record", { "docs-note.md": "note\n" });
  const docsFirst = commit(work, "record after docs", { "TASKBOARD.md": `board v1\n${MARKER}\n` });

  git(work, "checkout", "--quiet", "-b", "fakeMarker", live);
  const fakeMarker = commit(work, "closure without a real marker", { "TASKBOARD.md": "board v1\n<!-- marker -->\n" });

  git(work, "checkout", "--quiet", "-b", "closureThenDocs", closure);
  commit(work, "docs chore", { "docs/runbook.md": "runbook\n", "CLAUDE.md": "@AGENTS.md\n", "docs/新CRM全局结构技术方案.md": "方案\n" });
  const closureThenDocs = commit(work, "agent config", { ".claude/settings.json": "{}\n", "TASKBOARD.md": `board v1\n${MARKER}\n| NEXT | TODO |\n` });

  git(work, "checkout", "--quiet", "-b", "markerErased", closure);
  const markerErased = commit(work, "docs commit that also erases the marker", { "docs/a.md": "a\n", "TASKBOARD.md": "board v1\n" });

  git(work, "checkout", "--quiet", "-b", "liveOld", base);
  const liveOld = commit(work, "live release with the legacy checker", { "src.txt": "code v2 old\n", "scripts/check-release-closure.mjs": OLD_CHECKER });
  git(work, "checkout", "--quiet", "-b", "oldClosure", liveOld);
  const oldClosure = commit(work, "legacy closure", { "TASKBOARD.md": `board v1\n${MARKER}\n` });
  git(work, "checkout", "--quiet", "-b", "oldThenDocs", oldClosure);
  const oldThenDocs = commit(work, "docs after the legacy closure", { "docs/x.md": "x\n" });

  git(work, "checkout", "--quiet", "-b", "closureThenSrc", closureThenDocs);
  const closureThenSrc = commit(work, "source after docs", { "src.txt": "code v3\n" });

  git(work, "checkout", "--quiet", "-b", "closureThenInfra", closure);
  const closureThenInfra = commit(work, "infra after closure", { "infra/x.sh": "#!/bin/sh\n" });

  git(work, "checkout", "--quiet", "-b", "mergeRight", closure);
  commit(work, "right docs", { "docs/right.md": "right\n" });
  git(work, "checkout", "--quiet", "-b", "closureThenMerge", closure);
  commit(work, "left docs", { "docs/left.md": "left\n" });
  git(work, "merge", "--quiet", "--no-ff", "--no-edit", "mergeRight");
  const closureThenMerge = git(work, "rev-parse", "HEAD");

  git(work, "checkout", "--quiet", "-b", "sibling", base);
  const sibling = commit(work, "unrelated line of history", { "src.txt": "code v9\n" });

  return {
    mirror: path.join(work, ".git"),
    base, live, closure, source, taskboardTwice, docsFirst, fakeMarker,
    closureThenDocs, closureThenSrc, closureThenInfra, closureThenMerge, markerErased,
    liveOld, oldClosure, oldThenDocs, sibling,
  };
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

test("a closure record followed only by non-runtime commits is still reachable, so deploying over it is refused", () => {
  for (const [name, candidate] of [["taskboardTwice", REPO.taskboardTwice], ["closureThenDocs", REPO.closureThenDocs]]) {
    const result = ask({ status: "acceptance_verified", candidate });
    assert.equal(result.code, 65, `${name}: ${result.stdout}`);
    assert.match(result.stderr, /closure commit is still reachable; finalize it instead of deploying/, name);
    assert.equal(result.stdout, "", name);
  }
});

test("a runtime path, a merge, or a docs commit ahead of the record consumes the slot", () => {
  for (const [name, candidate, commits] of [
    ["closureThenSrc", REPO.closureThenSrc, 4],
    ["closureThenInfra", REPO.closureThenInfra, 2],
    ["closureThenMerge", REPO.closureThenMerge, 4],
    ["docsFirst", REPO.docsFirst, 2],
  ]) {
    const result = ask({ status: "acceptance_verified", candidate });
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`closure_slot=consumed commits_since=${commits}$`, "m"), name);
    assert.equal(result.stderr, "", `${name}: the plain shape needs no note`);
  }
});

test("a live release whose own checker predates --final-sha keeps the single-slot rule", () => {
  // The legacy single child is still reachable: finalize with four arguments.
  const reachable = ask({ status: "acceptance_verified", live: REPO.liveOld, candidate: REPO.oldClosure });
  assert.equal(reachable.code, 65, reachable.stdout);
  assert.match(reachable.stderr, /closure commit is still reachable; finalize it instead of deploying/);

  // A docs commit after it would be tolerated by the current checker, but
  // finalize runs the release's OWN checker, which rejects --final-sha with exit
  // 64; refusing to deploy here would be the deadlock, so the slot is consumed.
  const consumed = ask({ status: "acceptance_verified", live: REPO.liveOld, candidate: REPO.oldThenDocs });
  assert.equal(consumed.code, 0, consumed.stderr);
  assert.match(consumed.stdout, /closure_slot=consumed commits_since=2$/m);
  assert.match(consumed.stderr, /own release-closure checker predates --final-sha/);
});

test("a closure the checker could not accept is reported as consumed, with the reason", () => {
  const erased = ask({ status: "acceptance_verified", candidate: REPO.markerErased });
  assert.equal(erased.code, 0, erased.stderr);
  assert.match(erased.stdout, /closure_slot=consumed commits_since=2$/m);
  assert.match(erased.stderr, /acceptance marker is no longer present exactly once in the candidate TASKBOARD\.md/);

  const fake = ask({ status: "acceptance_verified", candidate: REPO.fakeMarker });
  assert.equal(fake.code, 0, fake.stderr);
  assert.match(fake.stdout, /closure_slot=consumed commits_since=1$/m);
  assert.match(fake.stderr, /does not add exactly one acceptance marker/);
});

test("the final-run SHA is passed to the release's checker and finalizer only when it differs from the closure", () => {
  const helpers = [
    extractSubshellFunction(WRAPPER, CHECKER_ARGS_NAME),
    extractSubshellFunction(WRAPPER, EVIDENCE_ARGS_NAME),
  ].join("\n");
  const script = path.join(TMP, "final-args.sh");
  writeFileSync(script, `${helpers}\nmapfile -t a < <(${CHECKER_ARGS_NAME}); mapfile -t b < <(${EVIDENCE_ARGS_NAME}); printf 'checker=%s\\n' "\${#a[@]}" "\${a[@]}"; printf 'evidence=%s\\n' "\${#b[@]}" "\${b[@]}"\n`);
  const closure = "b".repeat(40);
  const same = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, FINALIZE_CLOSURE_SHA: closure, FINALIZE_FINAL_SHA: closure } });
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.stdout, "checker=0\nevidence=0\n", "the single-slot flow invokes the release's tools exactly as before");
  const different = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, FINALIZE_CLOSURE_SHA: closure, FINALIZE_FINAL_SHA: "c".repeat(40) } });
  assert.equal(different.status, 0, different.stderr);
  assert.equal(different.stdout, `checker=2\nchecker=--final-sha\nchecker=${"c".repeat(40)}\nevidence=1\nevidence=${"c".repeat(40)}\n`);

  const wrapper = readFileSync(WRAPPER, "utf8");
  assert.equal(wrapper.split('"${final_sha_args[@]}"').length - 1, 2, "both checker invocations splice the conditional arguments");
  assert.doesNotMatch(wrapper, /--final-sha "\$FINALIZE_FINAL_SHA"/, "the flag is never passed unconditionally");
  assert.match(wrapper, /"\$FINALIZE_RUN_ID" "\$\{FINALIZE_EVIDENCE_FINAL_ARGS\[@\]\}"/);
});

test("the shell drift allowlist agrees with isClosureDriftAllowedPath on a shared corpus", () => {
  const corpus = [
    "TASKBOARD.md", "CLAUDE.md", "AGENTS.md", "README.md", "docs/a.md", "docs/deep/b.svg", "docs/x.excalidraw",
    ".claude/settings.json", ".claude/hooks/x.sh", "crm-v3/SPEC.md",
    "src/a.ts", "src/a.md", "supabase/migrations/x.sql", "supabase/README.md", "scripts/x.mjs", "scripts/README.md",
    "infra/x.sh", "infra/README.md", ".github/workflows/ci.yml", ".github/README.md", "tests/x.test.mjs",
    "public/robots.txt", "node_modules/x/README.md", "package.json", "package-lock.json", "next.config.ts",
    "tsconfig.json", "crm-v3/README.md", "crm-v3/ops/sync-metadata.json", "nested/x.md", "TASKBOARD.md.bak",
    "docs/../src/a.ts", "./README.md", "docs/./a.md", "/docs/a.md", "docs/", "docs", ".claude", "..", ".",
    "README.markdown", "x.MD", "docs/a.md ", " docs/a.md",
    "docs/新CRM全局结构技术方案.md", "新文档.md", "docs//x", "docs/a\\b.md", "a\\b.md", 'docs/a"b.md', "docs/a b.md",
    "a b.md", "docs/a\nb.md", ".md", "*.md", "Docs/y.md", "Src/a.js", "x.md/", "docs/x", "crm-v3/spec.md",
  ];
  const script = path.join(TMP, "paths.sh");
  // NUL-separated so a path containing a newline stays one verdict.
  writeFileSync(script, `${FUNCTION}\nfor file in "$@"; do if ${PATH_RULE_NAME} "$file"; then printf 'allow %s\\0' "$file"; else printf 'deny %s\\0' "$file"; fi; done\n`);
  const result = spawnSync("bash", [script, ...corpus], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const verdicts = result.stdout.split("\0").filter(Boolean);
  assert.equal(verdicts.length, corpus.length);
  for (const [index, file] of corpus.entries()) {
    const expected = isClosureDriftAllowedPath(file) ? "allow" : "deny";
    assert.equal(verdicts[index], `${expected} ${file}`, JSON.stringify(file));
  }
  assert.ok(corpus.some((file) => isClosureDriftAllowedPath(file)), "the corpus exercises the allow branch");
  assert.ok(corpus.some((file) => !isClosureDriftAllowedPath(file)), "the corpus exercises the deny branch");
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
  assert.equal(wrapper.split(`${PATH_RULE_NAME}() (`).length - 1, 1, "the path rule is defined once");
  assert.equal(wrapper.split(`${REACHABLE_NAME}() (`).length - 1, 1, "the reachability rule is defined once");
  assert.ok(wrapper.indexOf(`${PATH_RULE_NAME}() (`) < wrapper.indexOf(`${REACHABLE_NAME}() (`));
  assert.ok(wrapper.indexOf(`${REACHABLE_NAME}() (`) < wrapper.indexOf(`${FUNCTION_NAME}() (`));
  const definition = wrapper.indexOf(`${FUNCTION_NAME}() (`);
  const call = wrapper.indexOf(`  ${FUNCTION_NAME} \\`);
  assert.ok(call > definition, "the call site must follow the definition");
  assert.match(
    wrapper.slice(call),
    /^ {2}verify_live_release_permits_new_release \\\n {4}"\$\{CURRENT_EVIDENCE_FILES\[0\]\}" "\$ROLLBACK_SHA" "\$SHA" \\\n {4}"\$DB_TRANSITION_ONLY" "\$DB_TRANSITION_OPERATION" "\$MIRROR" \|\| exit \$\?\n/,
  );
  assert.doesNotMatch(wrapper, /elif release_status != "complete":/, "the inline copy of the rule is gone");
});
