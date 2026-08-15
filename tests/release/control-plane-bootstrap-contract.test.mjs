/**
 * Round-3 finding P1-10: the `f37c203` wrapper -> candidate control-plane bootstrap.
 *
 * The review's requirement was specific: "Provide an explicit, guarded, reversible
 * bootstrap path and a behavior/contract test for `f37 wrapper -> candidate`,
 * proving no unguarded production mutation occurs before all applicable
 * preconditions."
 *
 * So this file does three things:
 *
 *  1. It executes scripts/verify-deploy-gate-record.mjs as a process against real
 *     files on disk, including the record the f37c203 wrapper produces — which is
 *     no record at all. That is behaviour, not a source-text assertion.
 *  2. It reads the f37c203 wrapper out of git and shows that it cannot satisfy the
 *     precondition, so under this release's installer it can mutate nothing.
 *  3. It holds the two sides of the contract equal — the gate names the wrapper
 *     writes and the gate names the installer requires — and asserts the ordering
 *     inside the installer that makes the transition reversible: the guard before
 *     every mutation, and the control plane inside the open transaction.
 *
 * No test here touches production, a service, sudoers, or the real
 * /var/lib/newme/deploy-state.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_GATES,
  DEFAULT_MAX_AGE_SECONDS,
  checkGateRecord,
  checkOwnership,
} from "../../scripts/verify-deploy-gate-record.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GUARD = path.join(REPO, "scripts/verify-deploy-gate-record.mjs");
const INSTALLER = path.join(REPO, "scripts/install-systemd-assets.sh");
const WRAPPER = path.join(REPO, "infra/systemd/newme-deploy.sh");
const ROLLBACK = path.join(REPO, "scripts/rollback-systemd-assets.sh");
const DOC = path.join(REPO, "infra/release/control-plane-bootstrap.md");

const installerSource = fs.readFileSync(INSTALLER, "utf8");
const wrapperSource = fs.readFileSync(WRAPPER, "utf8");
const rollbackSource = fs.readFileSync(ROLLBACK, "utf8");
const docSource = fs.readFileSync(DOC, "utf8");

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const NOW_MS = 1_700_000_000_000;

function stateRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newme-gate-record-"));
  return dir;
}

/** Write a gate record and stamp its mtime, so freshness is testable without waiting. */
function writeRecord(root, lines, { ageSeconds = 0, basename = "deploy-gates.AbC123" } = {}) {
  const file = path.join(root, basename);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const mtime = new Date(NOW_MS - ageSeconds * 1000);
  fs.utimesSync(file, mtime, mtime);
  return file;
}

function validLines(overrides = {}) {
  const { sha = SHA, event = "workflow_dispatch", run = "42", gates = REQUIRED_GATES } = overrides;
  return [`sha=${sha}`, `event=${event}`, `run=${run}`, ...gates.map((gate) => `gate=${gate}`)];
}

/** Run the guard exactly as the installer runs it, and return its real exit status. */
function runGuard({ record, root, expectSha = SHA, nowMs = NOW_MS, extra = [] }) {
  const args = [
    GUARD,
    "--record",
    record,
    "--expect-sha",
    expectSha,
    "--state-root",
    root,
    "--now-ms",
    String(nowMs),
    ...extra,
  ];
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

/**
 * The guard also requires the record to be root:root 0600 inside a root-owned 0700
 * directory. A test runner is not root, and a temporary directory is neither
 * root-owned nor 0700, so the accept path cannot be produced end-to-end here. It is
 * asserted in two halves instead, and neither half is allowed to be vacuous:
 *
 *   * the content half runs as a process and must produce exactly the host
 *     permission problems and nothing else — that is the record itself being
 *     accepted, stated as a refusal we can attribute line by line;
 *   * the permission half is asserted directly on checkOwnership() with the stat
 *     results a real deploy host produces.
 *
 * The end-to-end accept path was executed as root against a root-owned 0700
 * /var/lib/newme/deploy-state in a throwaway Linux container; see the P1-10 row in
 * TASKBOARD.md. It printed "4 required gate(s) accounted for".
 */
const PERMISSION_PROBLEMS = [
  "the gate record is not owned by root:root",
  "the gate record mode must be 0600",
  "the deploy-state directory is not root-owned 0700",
];
/** True where the platform reports no POSIX ownership, or where we really are root. */
const CAN_PRODUCE_ROOT_OWNED = typeof process.getuid !== "function" || process.getuid() === 0;

/** The guard's own problem lines, without the trailing count line. */
function problemLines(stderr) {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("deploy gate record: "))
    .map((line) => line.slice("deploy gate record: ".length))
    .filter((line) => !/^refusing to install the control plane: /.test(line));
}

function bootstrapProcedureSource() {
  const section = /## Authorised procedure[\s\S]*?```bash\n([\s\S]*?)\n```/.exec(docSource);
  assert.ok(section, "the authorised bootstrap shell block is missing");
  return section[1];
}

function bashExecutable() {
  if (process.platform !== "win32") return "bash";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const bash = path.join(programFiles, "Git", "bin", "bash.exe");
  assert.ok(fs.existsSync(bash), `Git Bash is required for the bootstrap behaviour test: ${bash}`);
  return bash;
}

function bashPath(value) {
  const normalized = value.replaceAll("\\", "/");
  return /^[A-Za-z]:\//.test(normalized)
    ? `/${normalized[0].toLowerCase()}${normalized.slice(2)}`
    : normalized;
}

function runDocumentedBootstrap({
  gitMode = "ok",
  bootstrapMode = "ok",
  sha = SHA,
  run = "42",
  migrationStatus = "applied_verified",
  migrationIds = "20260817170000",
  rollbackSha = OTHER_SHA,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newme-bootstrap-procedure-"));
  const bin = path.join(root, "bin");
  const fakeRun = path.join(root, "run");
  const installed = path.join(root, "installed-newme-deploy");
  const invocation = path.join(root, "invocation.log");
  const cleanup = path.join(root, "cleanup.log");
  const candidate = path.join(root, "candidate-newme-deploy");
  fs.mkdirSync(bin);
  fs.mkdirSync(fakeRun);

  fs.writeFileSync(
    candidate,
    `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' "$*" >"$FAKE_INVOCATION_LOG"
case "\${FAKE_BOOTSTRAP_MODE:-ok}" in
  ok) cp -- "$0" "$FAKE_INSTALLED_WRAPPER" ;;
  drift) { cat -- "$0"; printf '\\n# injected drift\\n'; } >"$FAKE_INSTALLED_WRAPPER" ;;
  fail) exit 52 ;;
  *) exit 53 ;;
esac
`,
  );
  fs.chmodSync(candidate, 0o755);

  const fakeSudo = path.join(bin, "sudo");
  fs.writeFileSync(
    fakeSudo,
    `#!/usr/bin/env bash
set -Eeuo pipefail
command_name=\${1:-}
shift || true
case "$command_name" in
  mktemp)
    mkdir -p "$FAKE_ROOT/run"
    command mktemp "$FAKE_ROOT/run/\${1##*/}"
    ;;
  git)
    case "\${FAKE_GIT_MODE:-ok}" in
      ok) cat -- "$FAKE_COORDINATOR_SOURCE" ;;
      empty) : ;;
      fail) exit 51 ;;
      *) exit 53 ;;
    esac
    ;;
  cmp)
    [ "\${1:-}" = -s ] && [ "\${3:-}" = /usr/local/sbin/newme-deploy ] || exit 54
    command cmp -s "$2" "$FAKE_INSTALLED_WRAPPER"
    ;;
  rm)
    printf '%s\\n' "$*" >>"$FAKE_CLEANUP_LOG"
    command rm "$@"
    ;;
  chmod|tee|test|bash)
    command "$command_name" "$@"
    ;;
  *) exit 55 ;;
esac
`,
  );
  fs.chmodSync(fakeSudo, 0o755);

  const quoted = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const source = bootstrapProcedureSource()
    .replace(/^sha=.*$/m, `sha=${quoted(sha)}`)
    .replace(/^run=.*$/m, `run=${quoted(run)}`)
    .replace(/^migration_status=.*$/m, `migration_status=${quoted(migrationStatus)}`)
    .replace(/^migration_ids=.*$/m, `migration_ids=${quoted(migrationIds)}`)
    .replace(/^rollback_sha=.*$/m, `rollback_sha=${quoted(rollbackSha)}`);
  const script = path.join(root, "bootstrap.sh");
  fs.writeFileSync(script, `${source}\n`);

  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
  const env = {
    ...process.env,
    FAKE_ROOT: bashPath(root),
    FAKE_GIT_MODE: gitMode,
    FAKE_BOOTSTRAP_MODE: bootstrapMode,
    FAKE_COORDINATOR_SOURCE: bashPath(candidate),
    FAKE_INSTALLED_WRAPPER: bashPath(installed),
    FAKE_INVOCATION_LOG: bashPath(invocation),
    FAKE_CLEANUP_LOG: bashPath(cleanup),
    [pathKey]: [bin, process.env[pathKey] || ""].filter(Boolean).join(path.delimiter),
  };
  const result = spawnSync(bashExecutable(), [script], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { result, root, fakeRun, installed, invocation, cleanup, candidate };
}

// ---------------------------------------------------------------------------
// 1 · Behaviour of the precondition
// ---------------------------------------------------------------------------

test("a record written after every gate passed, for this exact release, is accepted", () => {
  const root = stateRoot();
  const record = writeRecord(root, validLines());
  const result = runGuard({ record, root });
  if (CAN_PRODUCE_ROOT_OWNED) {
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${REQUIRED_GATES.length} required gate\\(s\\) accounted for`));
  } else {
    // Nothing about the record was rejected: every remaining objection is about
    // the test host's permissions, which the deploy host satisfies.
    assert.deepEqual(problemLines(result.stderr), PERMISSION_PROBLEMS, result.stderr);
    assert.equal(result.code, 1);
  }
  // The content half, with no host in it at all.
  assert.deepEqual(
    checkGateRecord({
      text: `${validLines().join("\n")}\n`,
      expectSha: SHA,
      mtimeMs: NOW_MS,
      nowMs: NOW_MS,
    }),
    [],
  );
});

test("the permission half of the guard accepts a real deploy host and refuses a writable one", () => {
  const rootOwnedRecord = { uid: 0, gid: 0, mode: 0o100600 };
  const rootOwnedDir = { uid: 0, gid: 0, mode: 0o40700 };
  assert.deepEqual(
    checkOwnership({ recordStat: rootOwnedRecord, stateRootStat: rootOwnedDir, enforce: true }),
    [],
  );
  assert.deepEqual(
    checkOwnership({
      recordStat: { uid: 1001, gid: 1001, mode: 0o100644 },
      stateRootStat: { uid: 1001, gid: 1001, mode: 0o40755 },
      enforce: true,
    }),
    PERMISSION_PROBLEMS,
  );
  // A group-readable record in the right directory is still a refusal: the record
  // must not be readable or writable by anything but root.
  assert.deepEqual(
    checkOwnership({ recordStat: { uid: 0, gid: 0, mode: 0o100640 }, stateRootStat: rootOwnedDir, enforce: true }),
    ["the gate record mode must be 0600"],
  );
  assert.deepEqual(
    checkOwnership({ recordStat: rootOwnedRecord, stateRootStat: null, enforce: true }),
    ["the deploy-state directory is missing"],
  );
});

test("the f37c203 outcome — no record at all — is a refusal, not a default-allow", () => {
  const root = stateRoot();
  const result = runGuard({ record: path.join(root, "deploy-gates.MissinG") });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /there is no gate record: the deploy wrapper did not record that its gates ran/);
});

test("a record for another release cannot be reused for this one", () => {
  const root = stateRoot();
  const record = writeRecord(root, validLines({ sha: OTHER_SHA }));
  const result = runGuard({ record, root });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /but the release being installed is/);
});

test("a record left behind by an earlier deployment of the same SHA is stale, not evidence", () => {
  const root = stateRoot();
  // A record just inside the window is not stale. Asserted on the content half,
  // because the process half would also object to the test host's permissions.
  const fresh = writeRecord(root, validLines(), { ageSeconds: DEFAULT_MAX_AGE_SECONDS - 60 });
  assert.deepEqual(
    checkGateRecord({
      text: fs.readFileSync(fresh, "utf8"),
      expectSha: SHA,
      mtimeMs: NOW_MS - (DEFAULT_MAX_AGE_SECONDS - 60) * 1000,
      nowMs: NOW_MS,
    }),
    [],
  );
  assert.deepEqual(problemLines(runGuard({ record: fresh, root }).stderr).filter((line) => /window/.test(line)), []);

  const stale = writeRecord(root, validLines(), {
    ageSeconds: DEFAULT_MAX_AGE_SECONDS + 60,
    basename: "deploy-gates.StaleR1",
  });
  const result = runGuard({ record: stale, root });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /older than the \d+s window/);
});

test("every single required gate is individually required", () => {
  const root = stateRoot();
  for (const [index, omitted] of REQUIRED_GATES.entries()) {
    const gates = REQUIRED_GATES.filter((gate) => gate !== omitted);
    const record = writeRecord(root, validLines({ gates }), { basename: `deploy-gates.Omit00${index}` });
    const result = runGuard({ record, root });
    assert.equal(result.code, 1, `omitting ${omitted} was accepted`);
    assert.match(result.stderr, new RegExp(`does not account for: .*${omitted}`));
  }
});

test("a wrapper from a different release, naming gates this installer never heard of, is refused", () => {
  const root = stateRoot();
  const record = writeRecord(root, validLines({ gates: [...REQUIRED_GATES, "hermes-alerting-verified"] }));
  const result = runGuard({ record, root });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /claims gates this installer does not know: hermes-alerting-verified/);
});

test("a duplicated gate line cannot stand in for a gate that is missing", () => {
  const root = stateRoot();
  // The first gate twice, and the last one left out: the count is right and the
  // set is not. Derived from REQUIRED_GATES so adding a gate cannot make this
  // test stop being about the last one.
  const gates = [REQUIRED_GATES[0], ...REQUIRED_GATES.slice(0, -1)];
  const record = writeRecord(root, validLines({ gates }));
  const result = runGuard({ record, root });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /names .* twice/);
  assert.match(result.stderr, new RegExp(`does not account for: ${REQUIRED_GATES.at(-1)}`));
});

test("only a release-candidate workflow_dispatch run counts, and the run must be named", () => {
  const root = stateRoot();
  const pushed = writeRecord(root, validLines({ event: "push" }));
  const pushResult = runGuard({ record: pushed, root });
  assert.equal(pushResult.code, 1);
  assert.match(pushResult.stderr, /only a release-candidate workflow_dispatch run is evidence/);

  const unrun = writeRecord(root, validLines({ run: "" }), { basename: "deploy-gates.NoRun01" });
  const unrunResult = runGuard({ record: unrun, root });
  assert.equal(unrunResult.code, 1);
  assert.match(unrunResult.stderr, /does not name the workflow run/);
});

test("the record must live in the protected deploy-state directory under its own name", () => {
  const root = stateRoot();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "newme-gate-elsewhere-"));
  const outside = writeRecord(elsewhere, validLines());
  const outsideResult = runGuard({ record: outside, root });
  assert.equal(outsideResult.code, 1);
  assert.match(outsideResult.stderr, /must live in/);

  const misnamed = writeRecord(root, validLines(), { basename: "gates.txt" });
  const misnamedResult = runGuard({ record: misnamed, root });
  assert.equal(misnamedResult.code, 1);
  assert.match(misnamedResult.stderr, /is not a deploy-gates\.\* record name/);
});

test("junk, unknown keys and repeated keys are refused rather than partially believed", () => {
  const root = stateRoot();
  const record = writeRecord(root, [...validLines(), "gates_all_passed=yes", "sha=" + OTHER_SHA, "not a pair"]);
  const result = runGuard({ record, root });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown key "gates_all_passed"/);
  assert.match(result.stderr, /sets sha twice/);
  assert.match(result.stderr, /not key=value/);
});

test("an empty record is refused with the gates named, not silently accepted", () => {
  const root = stateRoot();
  const record = writeRecord(root, []);
  const result = runGuard({ record, root });
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`does not account for: ${REQUIRED_GATES.join(", ")}`));
});

// ---------------------------------------------------------------------------
// 2 · The f37c203 wrapper, read out of git
// ---------------------------------------------------------------------------

test("the f37c203 wrapper running in production sets no gate record and runs none of the new gates", () => {
  const legacy = execFileSync("git", ["-C", REPO, "show", "f37c203:infra/systemd/newme-deploy.sh"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

  // It does call this installer — that is the whole exposure.
  assert.match(legacy, /bash "\$WORKTREE\/scripts\/install-systemd-assets\.sh"/);
  // And it passes nothing that could satisfy the precondition.
  assert.doesNotMatch(legacy, /NEWME_DEPLOY_GATE_RECORD/);
  assert.doesNotMatch(legacy, /deploy-gates/);
  // The three gates the review named as absent.
  assert.doesNotMatch(legacy, /CI_EVENT=/);
  assert.doesNotMatch(legacy, /check-taskboard/);
  assert.doesNotMatch(legacy, /verify-remote-migration-history/);
  // Nor did it back up the control plane it was about to replace.
  assert.doesNotMatch(legacy, /CONTROL_PLANE/);

  // Therefore, behaviourally: the only environment it exports to the installer is
  // the asset backup record, which produces the "no gate record" refusal above.
  const call = /((?:[A-Z_]+="[^"]*"\s+)*)bash "\$WORKTREE\/scripts\/install-systemd-assets\.sh"/.exec(legacy);
  assert.ok(call, "the f37c203 installer call could not be located");
  const exported = call[1].match(/[A-Z_]+(?==)/g) ?? [];
  assert.deepEqual(exported, ["NEWME_ASSET_BACKUP_RECORD"]);
});

// ---------------------------------------------------------------------------
// 3 · The contract between the wrapper and the installer
// ---------------------------------------------------------------------------

test("the candidate wrapper writes exactly the gates the installer requires", () => {
  const heredoc = /^\s*cat > "\$GATE_RECORD" <<EOF\n([\s\S]*?)\nEOF\n/m.exec(wrapperSource);
  assert.ok(heredoc, "the wrapper does not write a gate record heredoc");
  const body = heredoc[1];
  const written = [...body.matchAll(/^gate=(.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(
    [...written].sort(),
    [...REQUIRED_GATES].sort(),
    "the wrapper and scripts/verify-deploy-gate-record.mjs disagree about the required gates",
  );
  assert.match(body, /^sha=\$SHA$/m);
  assert.match(body, /^event=\$CI_EVENT$/m);
  assert.match(body, /^run=\$RUN_ID$/m);
  // A record must never be readable or writable by anyone but root.
  assert.match(wrapperSource, /GATE_RECORD="\$\(mktemp "\$STATE_ROOT\/deploy-gates\.XXXXXX"\)"\nchmod 0600 "\$GATE_RECORD"/);
  // And it must be handed to the installer along with the interpreter that checks it.
  assert.match(wrapperSource, /NEWME_DEPLOY_GATE_RECORD="\$GATE_RECORD" \\\nNEWME_NODE_BIN="\$NODE_BIN" \\\n\s*bash "\$WORKTREE\/scripts\/install-systemd-assets\.sh"/);
});

test("the wrapper writes the record only after every release-candidate gate has actually run", () => {
  const at = (pattern) => {
    const index = wrapperSource.search(pattern);
    assert.notEqual(index, -1, `not found in the wrapper: ${pattern}`);
    return index;
  };
  const written = at(/^GATE_RECORD="\$\(mktemp/m);
  assert.ok(at(/CI_EVENT=workflow_dispatch/) < written, "the event is claimed before it is set");
  assert.ok(at(/required-jobs\.json/) < written, "the job-level gate runs after the record is written");
  // Round-4 C4-4: the scope, not --require-complete. The gate the wrapper can
  // actually satisfy is the predeploy milestone; release-final completeness is the
  // required CI job's, and the gate record is named for what was measured.
  assert.ok(
    at(/check-taskboard\.mjs" --require-scope=predeploy_ready/) < written,
    "the taskboard gate runs after the record",
  );
  assert.doesNotMatch(wrapperSource, /check-taskboard\.mjs" --require-complete/);
  assert.ok(at(/verify-remote-migration-history\.mjs/) < written, "the history gate runs after the record");
  // Round-4 C4-5, and it must read both sides out of the candidate's own worktree:
  // a companion check against some other tree proves nothing about this release.
  assert.ok(
    at(/check-release-manifest\.mjs --verify-companions/) < written,
    "the companion gate runs after the record is written",
  );
  assert.match(
    wrapperSource,
    /\(cd "\$WORKTREE" && "\$NODE_BIN" scripts\/check-release-manifest\.mjs --verify-companions\)/,
  );
  // The record is written after the gates and before the installer, and nowhere else.
  assert.equal((wrapperSource.match(/mktemp "\$STATE_ROOT\/deploy-gates\.XXXXXX"/g) ?? []).length, 1);
  const ordinaryInstaller = wrapperSource.indexOf('bash "$WORKTREE/scripts/install-systemd-assets.sh"', written);
  assert.ok(ordinaryInstaller > written);
});

test("the record is removed on every exit path, so it can never gate a later installer", () => {
  assert.match(wrapperSource, /remove_gate_record\(\) \{/);
  // Only paths inside the protected directory are ever unlinked.
  assert.match(wrapperSource, /case "\$GATE_RECORD" in\n\s*"\$STATE_ROOT"\/deploy-gates\.\*\) rm -f -- "\$GATE_RECORD" ;;/);
  // Removed as soon as the installer returns...
  const call = wrapperSource.indexOf('bash "$WORKTREE/scripts/install-systemd-assets.sh"');
  assert.notEqual(call, -1);
  assert.match(wrapperSource.slice(call, call + 400), /\nremove_gate_record\n/);
  // ...and by the failure path, which must still be the wrapper's own cleanup: the
  // gate record must not be handled by replacing the EXIT trap that performs the
  // asset rollback and removes the worktree.
  const cleanup = /cleanup\(\) \{\n([\s\S]*?)\n\}\ntrap cleanup EXIT/.exec(wrapperSource);
  assert.ok(cleanup, "the wrapper's cleanup trap is not installed as expected");
  assert.match(cleanup[1], /\bremove_gate_record\b/);
  assert.doesNotMatch(wrapperSource, /trap remove_gate_record EXIT/);
});

test("bootstrap is a coordinator mode, not a hand-written installer bypass", () => {
  const modeRouter = /BOOTSTRAP_ONLY=0\nDB_TRANSITION_ONLY=0\nDB_TRANSITION_OPERATION=""\ncase "\$\{1:-\}" in\n([\s\S]*?)\nesac/.exec(
    wrapperSource,
  );
  assert.ok(modeRouter, "the wrapper has no explicit operation-mode router");
  assert.match(modeRouter[1], /bootstrap\)\n\s*BOOTSTRAP_ONLY=1\n\s*shift\n\s*;;/);
  assert.match(modeRouter[1], /db-transition\)\n\s*DB_TRANSITION_ONLY=1\n\s*shift\n\s*;;/);
  assert.match(wrapperSource, /newme-deploy bootstrap <main-sha> <successful-run-id>/);

  const start = wrapperSource.indexOf('if [ "$BOOTSTRAP_ONLY" -eq 1 ]; then');
  const end = wrapperSource.indexOf('\nfi\n\nrequire_canonical_main_sha "$SHA" || {', start);
  assert.ok(start > 0 && end > start, "the bootstrap coordinator branch is missing");
  const body = wrapperSource.slice(start, end);
  const at = (needle) => {
    const index = body.indexOf(needle);
    assert.notEqual(index, -1, `bootstrap does not perform: ${needle}`);
    return index;
  };

  const service = at("systemctl is-active --quiet newme-platform");
  const health = at("http://127.0.0.1:3001/api/health");
  const finalize = at('bash "$WORKTREE/scripts/install-systemd-assets.sh" finalize');
  const pending = at('if [ -e "$PENDING_ASSET_RECORD" ] || [ -L "$PENDING_ASSET_RECORD" ]');
  const success = at("systemd_asset_transaction=none");
  assert.ok(service < health && health < finalize && finalize < pending && pending < success);

  // All candidate verification and the machine-created one-use gate record are in
  // the shared path before the bootstrap branch; the branch cannot call the
  // installer directly or accept operator-authored gate names.
  const install = wrapperSource.indexOf('bash "$WORKTREE/scripts/install-systemd-assets.sh"');
  assert.ok(install > 0 && install < start);
  assert.doesNotMatch(body, /NEWME_DEPLOY_GATE_RECORD|gate=/);
  assert.doesNotMatch(body, /deploy-immutable\.sh/);
});

test("the installer verifies the record before it can mutate anything", () => {
  // finalize mode (round-4 C2) sits before the gate check and exits inside its own
  // branch, so it is not on the path this test is about — but it does repeat some of
  // install mode's refusal wording, and a first-occurrence search would find its
  // copy. It is removed here, after proving it cannot fall through into install
  // mode: every exit from the branch is an exit from the process.
  const finalizeStart = installerSource.indexOf('if [ "$MODE" = finalize ]; then');
  assert.notEqual(finalizeStart, -1, "there is no finalize mode");
  const finalizeEnd = installerSource.indexOf("\nfi\n", finalizeStart);
  assert.ok(finalizeEnd > finalizeStart, "the finalize branch is unterminated");
  const finalizeBody = installerSource.slice(finalizeStart, finalizeEnd);
  assert.match(finalizeBody, /\n  exit 0\n$|\n  exit 0$/);
  assert.equal(finalizeBody.split("\n").filter((line) => /^  (?:exit|:)/.test(line) && !/^  exit \d+$/.test(line)).length, 0);
  let installPath = installerSource.slice(0, finalizeStart) + installerSource.slice(finalizeEnd);
  const credentialStart = installPath.indexOf("# Protected credential-remediation subset");
  const credentialEnd = installPath.indexOf('PREVIOUS_CURRENT="$(readlink -f /opt/newme/current', credentialStart);
  assert.ok(credentialStart > 0 && credentialEnd > credentialStart, "credential-only branches are not bounded");
  installPath = installPath.slice(0, credentialStart) + installPath.slice(credentialEnd);

  const at = (pattern) => {
    const index = installPath.search(pattern);
    assert.notEqual(index, -1, `not found in the installer: ${pattern}`);
    return index;
  };
  const guard = at(/verify-deploy-gate-record\.mjs/);

  // The gate check is install-only and is bound to the SHA of the tree in hand.
  assert.match(
    installerSource,
    /"\$GATE_NODE_BIN" "\$ROOT\/scripts\/verify-deploy-gate-record\.mjs" \\\n\s*--record "\$GATE_RECORD" \\\n\s*--expect-sha "\$SOURCE_SHA" \\\n\s*--state-root "\$STATE_ROOT"/,
  );
  // Absence is a refusal with its own exit code, before anything else.
  assert.match(installerSource, /no deploy gate record was passed/);
  assert.equal((installerSource.match(/exit 78/g) ?? []).length, 4);

  // Nothing that changes the host may precede it. The unresolved-transaction
  // recovery restarts the service, so it counts.
  for (const pattern of [
    /an unresolved production rollback must be recovered/,
    /recovering unresolved versioned assets from/,
    /^\s*BACKUP="\$\(mktemp -d/m,
    /trap rollback_on_error EXIT/,
    /^install_control_script /m,
    /^install_control_sudoers /m,
    /^rm -f -- \/etc\/sudoers\.d\/ubuntu-nopasswd$/m,
    /^install -D /m,
    /^systemctl daemon-reload$/m,
    /^visudo -c$/m,
  ]) {
    assert.ok(at(pattern) > guard, `the installer reaches ${pattern} before verifying the gate record`);
  }

  // The one thing that does precede it is creating and validating the protected
  // directory the record must live in — which is where it has to be.
  const before = installPath.slice(0, guard);
  assert.match(before, /install -d -o root -g root -m 0700 "\$STATE_ROOT"/);
  assert.equal((before.match(/^install -D /gm) ?? []).length, 0);
  assert.equal((before.match(/^systemctl /gm) ?? []).length, 0);
});

test("every control-plane path the installer writes is in the remembered backup set", () => {
  const block = /^CONTROL_PLANE=\(\n([\s\S]*?)\n\)/m.exec(installerSource);
  assert.ok(block, "the installer has no CONTROL_PLANE set");
  const controlPlane = block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  // The review named these five, and the sudoers fragments are the same problem.
  for (const required of [
    "/usr/local/sbin/newme-deploy",
    "/usr/local/sbin/newme-service-control",
    "/usr/local/sbin/newme-production-rollback",
    "/usr/local/libexec/newme/newme-install-systemd-assets",
    "/usr/local/libexec/newme/newme-rollback-systemd-assets",
    "/usr/local/libexec/newme/newme-validate-production-config.py",
    "/usr/local/libexec/newme/newme-credential-transition.mjs",
    "/etc/sudoers.d/newme-platform",
    "/etc/sudoers.d/ubuntu-nopasswd",
  ]) {
    assert.ok(controlPlane.includes(required), `${required} is not remembered before it is replaced`);
  }

  // Every destination the installer actually writes atomically must be in the set,
  // so adding a control script without a backup is a test failure.
  const destinations = [...installerSource.matchAll(/^install_control_(?:script|sudoers) \S+ (\S+)$/gm)].map(
    (match) => match[1],
  );
  assert.ok(destinations.length >= 8);
  for (const destination of destinations) {
    assert.ok(controlPlane.includes(destination), `${destination} is installed but not remembered`);
  }
  // And the unconditional removal must be reversible for the same reason.
  assert.match(installerSource, /^rm -f -- \/etc\/sudoers\.d\/ubuntu-nopasswd$/m);

  // The remember loop must cover both sets.
  assert.match(installerSource, /for p in "\$\{MANAGED\[@\]\}" "\$\{CONTROL_PLANE\[@\]\}"[^\n]*; do remember "\$p"; done/);
});

test("finalize verifies exactly the control plane install writes, from the same sources", () => {
  // Round-4 review C2. `finalize` declares a hand-run transaction complete only if
  // the control plane on disk is this release's, so its idea of "the control plane"
  // has to be the installer's. The two lists are written separately — the install
  // calls are ordered, dependency before consumer, and finalize is a data table
  // reached before any of them — so their agreement is asserted here instead of
  // being left to whoever edits one of them next.
  const block = /^  FINALIZE_CONTROL_PLANE=\(\n([\s\S]*?)\n  \)/m.exec(installerSource);
  assert.ok(block, "finalize mode has no control-plane table");
  const finalized = block[1]
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((entry) => {
      const [source, destination, mode] = entry.split(":");
      const expectedMode = destination === "/usr/local/share/newme/credential-live-attestation-policy-v1.json"
        ? "644"
        : /\/etc\/sudoers\.d\//.test(destination) ? "440" : "755";
      assert.equal(mode, expectedMode, `${destination} has no expected mode`);
      return { source, destination, mode };
    });

  const installed = [...installerSource.matchAll(/^install_control_(script|sudoers|file) "\$ROOT\/(\S+)" (\S+)(?: (0[0-7]{3}))?$/gm)].map(
    (match) => ({
      source: match[2],
      destination: match[3],
      mode: match[1] === "sudoers" ? "440" : match[1] === "file" ? match[4].slice(1) : "755",
    }),
  );
  assert.equal(installed.length, 10);
  assert.deepEqual(
    finalized.slice().sort((a, b) => a.destination.localeCompare(b.destination)),
    installed.slice().sort((a, b) => a.destination.localeCompare(b.destination)),
    "finalize and install disagree about the control plane",
  );

  // The modes finalize requires must be the ones the installers actually set.
  assert.match(installerSource, /install_control_script\(\)[\s\S]*?install -o root -g root -m 0755 "\$source" "\$temporary"/);
  assert.match(installerSource, /install_control_sudoers\(\)[\s\S]*?install -o root -g root -m 0440 "\$source" "\$temporary"/);
  // And the one path install removes rather than writes is checked as removed.
  assert.match(installerSource, /the control plane is not this release's: \/etc\/sudoers\.d\/ubuntu-nopasswd is still present/);
});

test("finalize is guarded, idempotent, and closes the transaction only after verifying it", () => {
  const finalize = /^if \[ "\$MODE" = finalize \]; then\n([\s\S]*?)\n^fi$/m.exec(installerSource);
  assert.ok(finalize, "there is no finalize mode");
  const body = finalize[1];

  // Nothing automated can call it.
  assert.match(body, /NEWME_ASSET_FINALIZE_CONFIRM:-\}" = bootstrap/);
  // No record is success: a crash between the removal and the flush must be
  // recoverable by running it again.
  assert.match(body, /if \[ ! -e "\$PENDING_RECORD" \] && \[ ! -L "\$PENDING_RECORD" \]; then\n\s*#[^\n]*\n\s*#[^\n]*\n\s*echo "systemd_asset_transaction=none"\n\s*exit 0/);
  // It refuses while a production rollback is unresolved.
  assert.match(body, /PRODUCTION_ROLLBACK_PENDING[\s\S]*?exit 75/);
  // It is bound to the release, not to whatever tree it was run from.
  assert.match(body, /git -C "\$ROOT" rev-parse HEAD/);
  assert.match(body, /\[ "\$FINALIZE_TREE_SHA" = "\$FINALIZE_SHA" \]/);
  // Both closable states, and nothing else.
  assert.match(body, /FINALIZE_STATE=candidate_active/);
  assert.match(body, /FINALIZE_STATE=control_plane_only/);
  assert.match(body, /matches neither the transaction's candidate nor its recovery point/);
  // The rollback target must still be whole.
  assert.match(body, /would roll back to is incomplete; it must not be closed/);

  // Ordering: every verification precedes the removal, and the removal is flushed
  // and then read back.
  const at = (needle) => {
    const index = body.indexOf(needle);
    assert.notEqual(index, -1, `not found in finalize: ${needle}`);
    return index;
  };
  const removal = at('rm -f -- "$PENDING_RECORD"');
  for (const needle of [
    'NEWME_ASSET_FINALIZE_CONFIRM:-}" = bootstrap',
    'git -C "$ROOT" rev-parse HEAD',
    'readlink -f /opt/newme/current',
    "$FINALIZE_BACKUP/rootfs",
    'cmp -s "$source" "$dest"',
    "/etc/sudoers.d/ubuntu-nopasswd is still present",
  ]) {
    assert.ok(at(needle) < removal, `finalize removes the pending record before checking ${needle}`);
  }
  assert.ok(at('sync -f "$STATE_ROOT"') > removal, "the removal is not flushed");
  assert.ok(at("the unresolved versioned asset pointer survived its removal") > removal);
  assert.ok(at("systemd_asset_transaction=none") < removal, "the idempotent report must come first");
  assert.match(body, /echo "finalized=\$FINALIZE_SHA state=\$FINALIZE_STATE backup=\$FINALIZE_BACKUP"/);

  // And it is one of the three modes the usage line offers.
  assert.match(installerSource, /install:0\|snapshot:1\|finalize:1/);
  assert.match(installerSource, /usage: install-systemd-assets\.sh \[snapshot\|finalize\]/);
});

test("the control plane is installed inside the open transaction, never before it", () => {
  const at = (pattern) => {
    const index = installerSource.search(pattern);
    assert.notEqual(index, -1, `not found in the installer: ${pattern}`);
    return index;
  };
  const remembered = at(/do remember "\$p"; done/);
  const trap = at(/^trap rollback_on_error EXIT$/m);
  const backupPointer = at(/printf '%s\\n' "\$BACKUP" > "\$NEWME_ASSET_BACKUP_RECORD"/);
  const pendingPointer = at(/^ln -- "\$PENDING_TMP" "\$PENDING_RECORD"$/m);
  const firstControlInstall = at(/^install_control_script /m);

  assert.ok(remembered < trap, "the control plane is remembered after the failure trap");
  assert.ok(trap < firstControlInstall, "the control plane is installed before the failure trap exists");
  assert.ok(backupPointer < firstControlInstall, "the control plane is installed before the recovery pointer");
  assert.ok(pendingPointer < firstControlInstall, "the control plane is installed before the pending pointer");

  // The controllers' dependencies go in before the controllers that call them, and
  // the wrapper — the file that gates everything — goes in last.
  const order = [...installerSource.matchAll(/^install_control_(?:script|sudoers) \S+ (\S+)$/gm)].map(
    (match) => match[1],
  );
  assert.ok(
    order.indexOf("/usr/local/libexec/newme/newme-rollback-systemd-assets") <
      order.indexOf("/usr/local/sbin/newme-production-rollback"),
    "the rollback controller is installed before the helper it calls",
  );
  assert.ok(
    order.indexOf("/usr/local/libexec/newme/newme-validate-production-config.py") <
      order.indexOf("/usr/local/libexec/newme/newme-credential-transition.mjs") &&
      order.indexOf("/usr/local/libexec/newme/newme-credential-transition.mjs") <
        order.indexOf("/usr/local/sbin/newme-deploy"),
    "the credential validator and transition helper are not installed before their coordinator",
  );
  assert.equal(order[order.length - 2], "/usr/local/sbin/newme-deploy");

  // And no versioned runtime asset is touched until the whole recovery plane is up.
  const firstVersionedInstall = at(/^install -D -o root -g root -m 0644 "\$UNIT"/m);
  assert.ok(firstControlInstall < firstVersionedInstall);
});

test("the restore path is managed-list driven and preserves remediated assets only after the durable marker", () => {
  // rollback-systemd-assets.sh iterates the recorded managed list, so the paths
  // added to CONTROL_PLANE[] are restored by the code that already exists. If this
  // ever became a hard-coded list, adding a path would silently not be restorable.
  assert.match(rollbackSource, /managed\.list/);
  const restoreBody = rollbackSource.slice(rollbackSource.indexOf('BACKUP="${1:-}"'));
  assert.match(restoreBody, /is_credential_protected_asset "\$dest" && continue/);
  assert.match(restoreBody, /CREDENTIAL_PROTECTION_ACTIVE/);
  assert.match(restoreBody, /credential-remediation\.protected\.json/);
  assert.match(restoreBody, /verify_credential_protected_assets/);
  assert.doesNotMatch(rollbackSource, /CONTROL_PLANE/);
});

test("the bootstrap document states the procedure and does not claim it was performed", () => {
  const doc = docSource;
  assert.match(doc, /Status: \*\*NOT EXECUTED\.\*\*/);
  assert.match(doc, /separately authorised production release action/);
  assert.match(doc, /sudo bash "\$coordinator" bootstrap/);
  assert.match(doc, /git --git-dir=\/opt\/newme\/repository\.git show/);
  assert.match(doc, /exact-head and every job in/);
  assert.match(doc, /production history verification/);
  assert.match(doc, /machine generation of the one-use installer gate record/);
  assert.match(doc, /application service and `\/api\/health` verification/);
  assert.match(doc, /require: systemd_asset_transaction=none/);

  // Operator-written labels are deliberately absent. The coordinator proves the
  // gates and writes the record itself.
  assert.doesNotMatch(doc, /^\s*gate=/m);
  assert.doesNotMatch(doc, /tee "\$record"/);
  assert.doesNotMatch(doc, /NEWME_DEPLOY_GATE_RECORD=/);
  assert.match(doc, /must never synthesize `gate=` labels/);

  // The doc keeps the transactional installer/rollback boundary findable.
  assert.match(doc, /scripts\/install-systemd-assets\.sh/);
  assert.match(doc, /scripts\/rollback-systemd-assets\.sh/);
  // The installer's refusal message points back at the document.
  assert.match(installerSource, /infra\/release\/control-plane-bootstrap\.md/);
});

test("the documented bootstrap shell is fail-closed and ordered around the candidate bytes", () => {
  const source = bootstrapProcedureSource();
  assert.match(source, /^set -Eeuo pipefail\n/);
  assert.ok(source.includes('[[ "$sha" =~ ^[0-9a-f]{40}$ ]]'));
  assert.ok(source.includes('[[ "$run" =~ ^[1-9][0-9]*$ ]]'));
  assert.ok(source.includes('[[ "$rollback_sha" =~ ^[0-9a-f]{40}$ ]]'));
  assert.ok(source.includes('[[ "$migration_ids" =~ ^[0-9]{14}(,[0-9]{14})*$ ]]'));

  assert.match(source, /cleanup\(\) \{[\s\S]*?rc=\$\?[\s\S]*?trap - EXIT[\s\S]*?set \+e[\s\S]*?sudo rm -f -- "\$coordinator"[\s\S]*?exit "\$rc"\n\}/);
  assert.equal((source.match(/trap cleanup EXIT/g) ?? []).length, 1);
  assert.equal((source.match(/sudo rm -f -- "\$coordinator"/g) ?? []).length, 1);

  const at = (needle) => {
    const index = source.indexOf(needle);
    assert.notEqual(index, -1, `not found in documented bootstrap: ${needle}`);
    return index;
  };
  const validation = at('[[ "$sha" =~ ^[0-9a-f]{40}$ ]]');
  const mktemp = at("coordinator=\"$(sudo mktemp /run/newme-bootstrap.XXXXXX)\"");
  const show = at("sudo git --git-dir=/opt/newme/repository.git show");
  const nonempty = at('sudo test -s "$coordinator"');
  const bootstrap = at('sudo bash "$coordinator" bootstrap');
  const installedBytes = at('sudo cmp -s "$coordinator" /usr/local/sbin/newme-deploy');
  assert.ok(validation < mktemp && mktemp < show && show < nonempty && nonempty < bootstrap && bootstrap < installedBytes);
  assert.match(
    source.slice(show, nonempty),
    /"\$\{sha\}:infra\/systemd\/newme-deploy\.sh" \| sudo tee "\$coordinator" >\/dev\/null/,
  );
  assert.doesNotMatch(source.slice(show, nonempty), /\|\|\s*true/);
});

test("the documented bootstrap runs the exact candidate and removes its temporary coordinator", (t) => {
  const run = runDocumentedBootstrap();
  t.after(() => fs.rmSync(run.root, { recursive: true, force: true }));
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(
    fs.readFileSync(run.invocation, "utf8").trim(),
    `bootstrap ${SHA} 42 applied_verified 20260817170000 ${OTHER_SHA}`,
  );
  assert.equal(fs.readFileSync(run.installed, "utf8"), fs.readFileSync(run.candidate, "utf8"));
  assert.deepEqual(fs.readdirSync(run.fakeRun), [], "the EXIT cleanup left the coordinator behind");
  assert.match(fs.readFileSync(run.cleanup, "utf8"), /-f -- .*newme-bootstrap\./);
});

test("pipe, empty-output, bootstrap, and installed-byte mutations all fail closed and clean up", (t) => {
  for (const [name, options, expectedStatus, invoked] of [
    ["git show producer failure", { gitMode: "fail" }, 51, false],
    ["empty git object", { gitMode: "empty" }, 1, false],
    ["candidate bootstrap failure", { bootstrapMode: "fail" }, 52, true],
    ["installed wrapper drift", { bootstrapMode: "drift" }, 1, true],
  ]) {
    const run = runDocumentedBootstrap(options);
    t.after(() => fs.rmSync(run.root, { recursive: true, force: true }));
    assert.equal(run.result.status, expectedStatus, `${name}: ${run.result.stderr}`);
    assert.equal(fs.existsSync(run.invocation), invoked, `${name}: unexpected coordinator invocation state`);
    assert.deepEqual(fs.readdirSync(run.fakeRun), [], `${name}: temporary coordinator survived`);
  }
});

test("invalid release SHA and workflow run id are refused before sudo creates a file", (t) => {
  for (const [name, options, message] of [
    ["release SHA", { sha: "A".repeat(40) }, /invalid release SHA/],
    ["workflow run", { run: "0" }, /invalid workflow run id/],
  ]) {
    const run = runDocumentedBootstrap(options);
    t.after(() => fs.rmSync(run.root, { recursive: true, force: true }));
    assert.equal(run.result.status, 64, `${name}: ${run.result.stderr}`);
    assert.match(run.result.stderr, message);
    assert.deepEqual(fs.readdirSync(run.fakeRun), [], `${name}: validation ran after mktemp`);
    assert.equal(fs.existsSync(run.cleanup), false, `${name}: sudo was invoked before validation`);
  }
});
