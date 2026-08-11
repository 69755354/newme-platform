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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { REQUIRED_GATES, DEFAULT_MAX_AGE_SECONDS } from "../../scripts/verify-deploy-gate-record.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GUARD = path.join(REPO, "scripts/verify-deploy-gate-record.mjs");
const INSTALLER = path.join(REPO, "scripts/install-systemd-assets.sh");
const WRAPPER = path.join(REPO, "infra/systemd/newme-deploy.sh");
const ROLLBACK = path.join(REPO, "scripts/rollback-systemd-assets.sh");
const DOC = path.join(REPO, "infra/release/control-plane-bootstrap.md");

const installerSource = fs.readFileSync(INSTALLER, "utf8");
const wrapperSource = fs.readFileSync(WRAPPER, "utf8");
const rollbackSource = fs.readFileSync(ROLLBACK, "utf8");

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

// ---------------------------------------------------------------------------
// 1 · Behaviour of the precondition
// ---------------------------------------------------------------------------

test("a record written after every gate passed, for this exact release, is accepted", () => {
  const root = stateRoot();
  const record = writeRecord(root, validLines());
  const result = runGuard({ record, root });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${REQUIRED_GATES.length} required gate\\(s\\) accounted for`));
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
  const fresh = writeRecord(root, validLines(), { ageSeconds: DEFAULT_MAX_AGE_SECONDS - 60 });
  assert.equal(runGuard({ record: fresh, root }).code, 0);

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
  const gates = [REQUIRED_GATES[0], REQUIRED_GATES[0], REQUIRED_GATES[1], REQUIRED_GATES[2]];
  const record = writeRecord(root, validLines({ gates }));
  const result = runGuard({ record, root });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /names .* twice/);
  assert.match(result.stderr, new RegExp(`does not account for: ${REQUIRED_GATES[3]}`));
});

test("only a release-final workflow_dispatch run counts, and the run must be named", () => {
  const root = stateRoot();
  const pushed = writeRecord(root, validLines({ event: "push" }));
  const pushResult = runGuard({ record: pushed, root });
  assert.equal(pushResult.code, 1);
  assert.match(pushResult.stderr, /only a release-final workflow_dispatch run is evidence/);

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
  const heredoc = /GATE_RECORD"\s*<<EOF\n([\s\S]*?)\nEOF\n/.exec(wrapperSource);
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

test("the wrapper writes the record only after all four gates have actually run", () => {
  const at = (pattern) => {
    const index = wrapperSource.search(pattern);
    assert.notEqual(index, -1, `not found in the wrapper: ${pattern}`);
    return index;
  };
  const written = at(/GATE_RECORD="\$\(mktemp/);
  assert.ok(at(/CI_EVENT=workflow_dispatch/) < written, "the event is claimed before it is set");
  assert.ok(at(/required-jobs\.json/) < written, "the job-level gate runs after the record is written");
  assert.ok(at(/check-taskboard\.mjs" --require-complete/) < written, "the taskboard gate runs after the record");
  assert.ok(at(/verify-remote-migration-history\.mjs/) < written, "the history gate runs after the record");
  // The record is written after the gates and before the installer, and nowhere else.
  assert.equal((wrapperSource.match(/mktemp "\$STATE_ROOT\/deploy-gates\.XXXXXX"/g) ?? []).length, 1);
  assert.ok(written < at(/bash "\$WORKTREE\/scripts\/install-systemd-assets\.sh"/));
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

test("the installer verifies the record before it can mutate anything", () => {
  const at = (pattern) => {
    const index = installerSource.search(pattern);
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
  assert.equal((installerSource.match(/exit 78/g) ?? []).length, 2);

  // Nothing that changes the host may precede it. The unresolved-transaction
  // recovery restarts the service, so it counts.
  for (const pattern of [
    /an unresolved production rollback must be recovered/,
    /recovering unresolved versioned assets from/,
    /^BACKUP="\$\(mktemp -d/m,
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
  const before = installerSource.slice(0, guard);
  assert.match(before, /install -d -o root -g root -m 0700 "\$STATE_ROOT"/);
  assert.equal((before.match(/^install -D /gm) ?? []).length, 0);
  assert.equal((before.match(/^systemctl /gm) ?? []).length, 0);
});

test("every control-plane path the installer writes is in the remembered backup set", () => {
  const block = /CONTROL_PLANE=\(\n([\s\S]*?)\n\)/.exec(installerSource);
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
  assert.ok(destinations.length >= 6);
  for (const destination of destinations) {
    assert.ok(controlPlane.includes(destination), `${destination} is installed but not remembered`);
  }
  // And the unconditional removal must be reversible for the same reason.
  assert.match(installerSource, /^rm -f -- \/etc\/sudoers\.d\/ubuntu-nopasswd$/m);

  // The remember loop must cover both sets.
  assert.match(installerSource, /for p in "\$\{MANAGED\[@\]\}" "\$\{CONTROL_PLANE\[@\]\}"[^\n]*; do remember "\$p"; done/);
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
  assert.equal(order[order.length - 2], "/usr/local/sbin/newme-deploy");

  // And no versioned runtime asset is touched until the whole recovery plane is up.
  const firstVersionedInstall = at(/^install -D -o root -g root -m 0644 "\$UNIT"/m);
  assert.ok(firstControlInstall < firstVersionedInstall);
});

test("the restore path needs no change of its own to put the old control plane back", () => {
  // rollback-systemd-assets.sh iterates the recorded managed list, so the paths
  // added to CONTROL_PLANE[] are restored by the code that already exists. If this
  // ever became a hard-coded list, adding a path would silently not be restorable.
  assert.match(rollbackSource, /managed\.list/);
  assert.doesNotMatch(rollbackSource, /newme-deploy\b/);
  assert.doesNotMatch(rollbackSource, /CONTROL_PLANE/);
});

test("the bootstrap document states the procedure and does not claim it was performed", () => {
  const doc = fs.readFileSync(DOC, "utf8");
  assert.match(doc, /Status: \*\*NOT EXECUTED\.\*\*/);
  assert.match(doc, /\[AUTHORISED ACTION\] Snapshot the current control plane first/);
  assert.match(doc, /\[AUTHORISED ACTION\] Install the candidate control plane once, by hand/);
  assert.match(doc, /newme-rollback-systemd-assets <snapshot path>/);
  assert.match(doc, /None of these may be marked ✅ from a code round/);
  for (const gate of REQUIRED_GATES) assert.ok(doc.includes(gate), `${gate} is undocumented`);
  // The doc must point at the guard and the installer by path, so it stays findable.
  assert.match(doc, /scripts\/verify-deploy-gate-record\.mjs/);
  assert.match(doc, /scripts\/install-systemd-assets\.sh/);
  // The installer's refusal message points back at the document.
  assert.match(installerSource, /infra\/release\/control-plane-bootstrap\.md/);
});
