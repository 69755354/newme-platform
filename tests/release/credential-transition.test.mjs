import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TransitionError,
  PROTECTED_VERSIONED_ASSETS,
  adoptServiceKeyStore,
  applyCredentialTransition,
  assertFixedRuntimeEnvironmentFile,
  assertMetadata,
  finalizeCredentialTransitionLive,
  inspectCredentialAwaitingState,
  recoverCredentialTransition,
  recoverServiceKeyAdoption,
} from "../../scripts/credential-transition.mjs";
import { validateCredentialRemediationCi } from "../../scripts/verify-credential-remediation-ci.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const oldCredential = `sb_secret_${"o".repeat(48)}`;
const newCredential = `sb_secret_${"n".repeat(48)}`;
const thirdCredential = `sb_secret_${"x".repeat(48)}`;
const sha = "a".repeat(40);
const runId = "424242";
const runAttempt = 1;
const transactionId = "11111111-1111-4111-8111-111111111111";
const precheckSha256 = "e".repeat(64);

const credentialManifest = JSON.parse(readFileSync(
  join(repository, "infra", "release", "credential-remediation-required-jobs.json"),
  "utf8",
));

function credentialCiFixture() {
  const head = "b".repeat(40);
  const required = credentialManifest.required_jobs.map(({ name }, index) => ({
    name,
    status: "completed",
    conclusion: "success",
    head_sha: head,
    started_at: `2026-08-15T00:${String(index).padStart(2, "0")}:00Z`,
    completed_at: `2026-08-15T00:${String(index).padStart(2, "0")}:30Z`,
  }));
  const skipped = credentialManifest.required_skipped_jobs.map(({ name }) => ({
    name,
    status: "completed",
    conclusion: "skipped",
    head_sha: head,
    started_at: null,
    completed_at: null,
  }));
  return {
    manifest: credentialManifest,
    expectedSha: head,
    expectedRun: "42424242",
    expectedAttempt: 2,
    now: new Date("2026-08-15T01:00:00Z"),
    workflow: { id: 310914082, name: "ci", path: ".github/workflows/ci.yml", state: "active" },
    run: {
      id: 42424242,
      run_attempt: 2,
      head_sha: head,
      name: "ci",
      path: ".github/workflows/ci.yml",
      workflow_id: 310914082,
      event: "workflow_dispatch",
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      created_at: "2026-08-14T23:55:00Z",
      run_started_at: "2026-08-15T00:00:00Z",
      updated_at: "2026-08-15T00:30:00Z",
    },
    jobsResponse: { total_count: required.length + skipped.length, jobs: [...required, ...skipped] },
  };
}

test("dedicated credential-remediation CI accepts only its exact successful/skipped job split", () => {
  const valid = credentialCiFixture();
  assert.deepEqual(validateCredentialRemediationCi(valid), []);
  const wrongSkip = structuredClone(valid);
  const skippedName = credentialManifest.required_skipped_jobs[0].name;
  const skippedJob = wrongSkip.jobsResponse.jobs.find(({ name }) => name === skippedName);
  skippedJob.conclusion = "success";
  assert.match(validateCredentialRemediationCi(wrongSkip).join("\n"), /required-skipped job/);

  const weakened = credentialCiFixture();
  weakened.manifest = structuredClone(weakened.manifest);
  weakened.manifest.required_jobs.pop();
  assert.match(validateCredentialRemediationCi(weakened).join("\n"), /exact canonical/);

  const incompleteExtra = credentialCiFixture();
  incompleteExtra.jobsResponse.jobs.push({ name: "Unexpected incomplete job", status: "queued", conclusion: null });
  incompleteExtra.jobsResponse.total_count += 1;
  assert.match(validateCredentialRemediationCi(incompleteExtra).join("\n"), /Unexpected incomplete job/);
});

test("dedicated credential-remediation CI refuses workflow lookalikes and stale starts", () => {
  const lookalike = credentialCiFixture();
  lookalike.workflow.path = ".github/workflows/lookalike.yml";
  assert.match(validateCredentialRemediationCi(lookalike).join("\n"), /workflow path/);
  const stale = credentialCiFixture();
  stale.now = new Date("2026-08-15T07:00:01Z");
  assert.match(validateCredentialRemediationCi(stale).join("\n"), /run is stale/);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "newme-credential-transition-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const inboxDir = join(root, "inbox");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(inboxDir, { mode: 0o700 });
  const runtime = join(root, "runtime.env");
  const inbox = join(inboxDir, "supabase-service-key.env");
  const releaseEnv = join(root, "release.env");
  const validator = join(root, "validator.py");
  const readiness = join(root, "readiness.sh");
  writeFileSync(runtime, [
    `NEWME_READINESS_TOKEN=${"c".repeat(64)}`,
    "NEXT_PUBLIC_SITE_URL=https://app.newme.ae",
    `SUPABASE_SERVICE_ROLE_KEY=${oldCredential}`,
    "UNRELATED_RUNTIME_SETTING=preserved",
    "",
  ].join("\n"));
  writeFileSync(inbox, `SUPABASE_SERVICE_ROLE_KEY=${newCredential}\n`);
  writeFileSync(releaseEnv, "RELEASE_FIXTURE=1\n");
  writeFileSync(validator, "# fixture\n");
  writeFileSync(readiness, "# fixture\n");
  for (const file of [runtime, inbox]) chmodSync(file, 0o600);

  const paths = {
    runtimeDir: root,
    runtime,
    runtimeNext: `${runtime}.next`,
    inboxDir,
    inbox,
    stateDir,
    pending: join(stateDir, "pending.json"),
    pendingNext: join(stateDir, "pending.next"),
    systemdPending: join(stateDir, "systemd-assets.pending"),
    credentialAssetsPending: join(stateDir, "credential-assets.pending"),
    productionRollbackPending: join(stateDir, "production-rollback.pending"),
    backup: join(stateDir, "previous.env"),
    backupPreparing: join(stateDir, "previous.env.preparing"),
    last: join(stateDir, "last.json"),
    lastNext: join(stateDir, "last.next"),
    protection: join(stateDir, "credential-remediation.protected.json"),
    protectionNext: join(stateDir, "credential-remediation.protected.next"),
    releaseEnv,
    validator,
    readiness,
    python: "python3",
    systemctl: "systemctl",
  };
  const calls = { validate: 0, restart: 0 };
  const options = {
    paths,
    securityChecks: false,
    durable: false,
    now: () => "2026-08-15T00:00:00.000Z",
    validateCandidate(candidate) {
      calls.validate += 1;
      const value = readFileSync(candidate, "utf8");
      assert.match(value, new RegExp(`SUPABASE_SERVICE_ROLE_KEY=${newCredential}`));
      assert.doesNotMatch(value, new RegExp(oldCredential));
    },
    restartAndVerify() {
      calls.restart += 1;
    },
    protectedAssetDigests() {
      return Object.fromEntries(Object.keys(PROTECTED_VERSIONED_ASSETS).map((path, index) => [
        path,
        `${(index % 16).toString(16)}`.repeat(64),
      ]));
    },
  };
  return { root, paths, calls, options };
}

function transition(fix, overrides = {}) {
  const runtime = readFileSync(fix.paths.runtime, "utf8");
  const replacement = `${runtime
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^[\t ]*(?:export[\t ]+)?SUPABASE_SERVICE_ROLE_KEY[\t ]*=/.test(line))
    .join("\n")
    .replace(/\n+$/u, "")}\nSUPABASE_SERVICE_ROLE_KEY=${newCredential}\n`;
  return applyCredentialTransition({
    sha,
    runId,
    runAttempt,
    transactionId,
    precheckSha256,
    transitionBeforeSha256: createHash("sha256").update(runtime).digest("hex"),
    transitionAfterSha256: createHash("sha256").update(replacement).digest("hex"),
    ...fix.options,
    ...overrides,
  });
}

function recovery(fix, overrides = {}) {
  return recoverCredentialTransition({
    ...fix.options,
    ...overrides,
  });
}

function liveFinalization(fix, overrides = {}) {
  const pending = JSON.parse(readFileSync(fix.paths.pending, "utf8"));
  return finalizeCredentialTransitionLive({
    sha,
    runId,
    runAttempt,
    transactionId,
    precheckSha256,
    beforeSha256: pending.before_sha256,
    afterSha256: pending.after_sha256,
    awaitingLastSha256: createHash("sha256").update(readFileSync(fix.paths.last)).digest("hex"),
    completionSha256: "f".repeat(64),
    ...fix.options,
    ...overrides,
  });
}

function assertNoCredential(value) {
  assert.doesNotMatch(value, new RegExp(`${oldCredential}|${newCredential}`));
}

test("credential transition atomically cuts over the fixed runtime store and preserves live-revocation evidence", (t) => {
  const fix = fixture(t);
  writeFileSync(fix.paths.protection, `${JSON.stringify({
    version: 1,
    candidate_sha: "c".repeat(40),
    activated_at: "2026-08-14T00:00:00.000Z",
  })}\n`);
  chmodSync(fix.paths.protection, 0o600);
  assert.deepEqual(transition(fix), { status: "awaiting_provider_revocation" });
  const runtime = readFileSync(fix.paths.runtime, "utf8");
  assert.match(runtime, /UNRELATED_RUNTIME_SETTING=preserved/);
  assert.match(runtime, new RegExp(`SUPABASE_SERVICE_ROLE_KEY=${newCredential}`));
  assert.doesNotMatch(runtime, new RegExp(oldCredential));
  assert.equal(fix.calls.validate, 1);
  assert.equal(fix.calls.restart, 1);
  for (const absent of [fix.paths.runtimeNext]) {
    assert.equal(existsSync(absent), false, `${absent} must be removed`);
  }
  for (const preserved of [fix.paths.inbox, fix.paths.pending, fix.paths.backup]) {
    assert.equal(existsSync(preserved), true, `${preserved} must be preserved until signed live completion`);
  }
  const pending = readFileSync(fix.paths.pending, "utf8");
  assert.equal(JSON.parse(pending).phase, "awaiting_provider_revocation");
  assert.equal(JSON.parse(pending).transaction_id, transactionId);
  assert.equal(JSON.parse(pending).ci_run_attempt, runAttempt);
  assert.equal(JSON.parse(pending).precheck_sha256, precheckSha256);
  assertNoCredential(pending);
  const last = readFileSync(fix.paths.last, "utf8");
  assert.equal(JSON.parse(last).status, "awaiting_provider_revocation");
  assert.equal(JSON.parse(last).transaction_id, transactionId);
  assert.equal(JSON.parse(last).ci_run_attempt, runAttempt);
  assert.equal(JSON.parse(last).precheck_sha256, precheckSha256);
  assertNoCredential(last);
  const protection = readFileSync(fix.paths.protection, "utf8");
  assert.equal(JSON.parse(protection).candidate_sha, sha);
  assert.equal(JSON.parse(protection).version, 2);
  assert.deepEqual(Object.keys(JSON.parse(protection).assets).sort(), Object.keys(PROTECTED_VERSIONED_ASSETS).sort());
  assertNoCredential(protection);
  assert.deepEqual(inspectCredentialAwaitingState(fix.options), {
    status: "awaiting_provider_revocation",
    candidateSha: sha,
    runId,
    runAttempt,
    transactionId,
    precheckSha256,
  });
});

test("awaiting status rejects missing or mismatched durable state", (t) => {
  const fix = fixture(t);
  assert.deepEqual(transition(fix), { status: "awaiting_provider_revocation" });
  rmSync(fix.paths.backup);
  assert.throws(
    () => inspectCredentialAwaitingState(fix.options),
    (error) => error instanceof TransitionError && error.code === "backup_missing",
  );
});

test("awaiting status rejects every unresolved staging artifact", (t) => {
  for (const pathKey of [
    "pendingNext", "backupPreparing", "runtimeNext", "lastNext", "protectionNext",
    "systemdPending", "credentialAssetsPending", "productionRollbackPending",
  ]) {
    const fix = fixture(t);
    assert.deepEqual(transition(fix), { status: "awaiting_provider_revocation" });
    writeFileSync(fix.paths[pathKey], "unresolved\n");
    assert.throws(
      () => inspectCredentialAwaitingState(fix.options),
      (error) => error instanceof TransitionError && error.code === "awaiting_state_has_conflicting_artifact",
    );
    rmSync(fix.paths[pathKey]);
  }
});

test("signed live finalization durably completes the transition and is idempotent", (t) => {
  const fix = fixture(t);
  assert.deepEqual(transition(fix), { status: "awaiting_provider_revocation" });
  const pending = JSON.parse(readFileSync(fix.paths.pending, "utf8"));
  const awaitingLastSha256 = createHash("sha256").update(readFileSync(fix.paths.last)).digest("hex");
  const args = {
    sha,
    runId,
    runAttempt,
    transactionId,
    precheckSha256,
    beforeSha256: pending.before_sha256,
    afterSha256: pending.after_sha256,
    awaitingLastSha256,
    completionSha256: "f".repeat(64),
    ...fix.options,
  };
  assert.deepEqual(finalizeCredentialTransitionLive(args), { status: "complete" });
  for (const removed of [fix.paths.inbox, fix.paths.pending, fix.paths.backup]) {
    assert.equal(existsSync(removed), false, `${removed} must be removed by the transition finalizer`);
  }
  const last = JSON.parse(readFileSync(fix.paths.last, "utf8"));
  assert.equal(last.status, "complete");
  assert.equal(last.awaiting_last_sha256, awaitingLastSha256);
  assert.equal(last.completion_sha256, "f".repeat(64));
  assertNoCredential(JSON.stringify(last));
  assert.deepEqual(finalizeCredentialTransitionLive(args), { status: "complete" });
});

test("signed live finalization resumes every cleanup checkpoint without deleting substituted input", (t) => {
  for (const checkpoint of [
    "after_live_complete_record",
    "after_live_inbox_removed",
    "after_live_backup_removed",
    "after_live_pending_removed",
  ]) {
    const fix = fixture(t);
    assert.deepEqual(transition(fix), { status: "awaiting_provider_revocation" });
    assert.throws(() => liveFinalization(fix, {
      checkpoint(name) {
        if (name === checkpoint) throw new Error(`simulated ${checkpoint}`);
      },
    }), new RegExp(`simulated ${checkpoint}`));
    const complete = JSON.parse(readFileSync(fix.paths.last, "utf8"));
    assert.equal(complete.status, "complete");
    const pending = existsSync(fix.paths.pending)
      ? JSON.parse(readFileSync(fix.paths.pending, "utf8"))
      : {
          before_sha256: complete.before_sha256,
          after_sha256: complete.after_sha256,
        };
    assert.deepEqual(finalizeCredentialTransitionLive({
      sha,
      runId,
      runAttempt,
      transactionId,
      precheckSha256,
      beforeSha256: pending.before_sha256,
      afterSha256: pending.after_sha256,
      awaitingLastSha256: complete.awaiting_last_sha256,
      completionSha256: complete.completion_sha256,
      ...fix.options,
    }), { status: "complete" });
    for (const removed of [fix.paths.inbox, fix.paths.pending, fix.paths.backup]) {
      assert.equal(existsSync(removed), false);
    }
  }

  const substituted = fixture(t);
  assert.deepEqual(transition(substituted), { status: "awaiting_provider_revocation" });
  assert.throws(() => liveFinalization(substituted, {
    checkpoint(name) {
      if (name === "after_live_complete_record") throw new Error("simulated complete-record crash");
    },
  }), /simulated complete-record crash/);
  writeFileSync(substituted.paths.inbox, `SUPABASE_SERVICE_ROLE_KEY=${thirdCredential}\n`);
  assert.throws(
    () => finalizeCredentialTransitionLive({
      sha,
      runId,
      runAttempt,
      transactionId,
      precheckSha256,
      beforeSha256: JSON.parse(readFileSync(substituted.paths.last, "utf8")).before_sha256,
      afterSha256: JSON.parse(readFileSync(substituted.paths.last, "utf8")).after_sha256,
      awaitingLastSha256: JSON.parse(readFileSync(substituted.paths.last, "utf8")).awaiting_last_sha256,
      completionSha256: "f".repeat(64),
      ...substituted.options,
    }),
    (error) => error instanceof TransitionError && error.code === "inbox_candidate_digest_mismatch",
  );
  assert.equal(existsSync(substituted.paths.inbox), true);
  assert.equal(existsSync(substituted.paths.pending), true);
  assert.equal(existsSync(substituted.paths.backup), true);
});

test("signed live finalization quarantines and revalidates every file immediately before deletion", (t) => {
  const cases = [
    {
      pathKey: "inbox",
      expectedCode: "inbox_candidate_digest_mismatch",
      replacement: `SUPABASE_SERVICE_ROLE_KEY=${thirdCredential}\n`,
    },
    {
      pathKey: "backup",
      expectedCode: "backup_digest_mismatch",
      replacement: "replacement backup bytes that must be preserved\n",
    },
    {
      pathKey: "pending",
      expectedCode: "live_finalizer_pending_mismatch",
      replacement(current) {
        const record = JSON.parse(current);
        record.started_at = "2026-08-15T00:00:01.000Z";
        return `${JSON.stringify(record)}\n`;
      },
    },
  ];

  for (const entry of cases) {
    const fix = fixture(t);
    assert.deepEqual(transition(fix), { status: "awaiting_provider_revocation" });
    let replacement;
    assert.throws(
      () => liveFinalization(fix, {
        checkpoint(name) {
          if (name !== "after_live_complete_record") return;
          const current = readFileSync(fix.paths[entry.pathKey], "utf8");
          replacement = typeof entry.replacement === "function"
            ? entry.replacement(current)
            : entry.replacement;
          writeFileSync(fix.paths[entry.pathKey], replacement);
          chmodSync(fix.paths[entry.pathKey], 0o600);
        },
      }),
      (error) => error instanceof TransitionError && error.code === entry.expectedCode,
    );
    assert.equal(readFileSync(fix.paths[entry.pathKey], "utf8"), replacement);
  }
});

test("signed live finalization discards only a trusted non-authoritative last staging file", (t) => {
  const fix = fixture(t);
  assert.deepEqual(transition(fix), { status: "awaiting_provider_revocation" });
  writeFileSync(fix.paths.lastNext, "partial trusted staging\n");
  chmodSync(fix.paths.lastNext, 0o600);
  assert.deepEqual(liveFinalization(fix), { status: "complete" });
  assert.equal(existsSync(fix.paths.lastNext), false);
});

test("candidate validation fails before the runtime or inbox is mutated", (t) => {
  const fix = fixture(t);
  const before = readFileSync(fix.paths.runtime, "utf8");
  let error;
  try {
    transition(fix, { validateCandidate() { throw new Error("fixture refusal"); } });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof TransitionError);
  assert.equal(error.code, "candidate_config_validation_failed");
  assertNoCredential(error.message);
  assert.equal(readFileSync(fix.paths.runtime, "utf8"), before);
  assert.equal(existsSync(fix.paths.inbox), true);
  assert.equal(existsSync(fix.paths.pending), false);
  assert.equal(existsSync(fix.paths.backup), false);
  assert.equal(existsSync(fix.paths.runtimeNext), false);
});

test("credential transition refuses a runtime that changed after the signed precheck", (t) => {
  const fix = fixture(t);
  const beforeRuntime = readFileSync(fix.paths.runtime);
  const beforeInbox = readFileSync(fix.paths.inbox);
  const staleRuntimeDigest = createHash("sha256").update("different-precheck-runtime").digest("hex");
  assert.throws(
    () => transition(fix, { transitionBeforeSha256: staleRuntimeDigest }),
    (error) => error instanceof TransitionError && error.code === "precheck_runtime_digest_mismatch",
  );
  assert.deepEqual(readFileSync(fix.paths.runtime), beforeRuntime);
  assert.deepEqual(readFileSync(fix.paths.inbox), beforeInbox);
  assert.equal(fix.calls.validate, 0);
  assert.equal(fix.calls.restart, 0);
  for (const absent of [fix.paths.pending, fix.paths.backup, fix.paths.runtimeNext, fix.paths.last]) {
    assert.equal(existsSync(absent), false, `${absent} must remain absent`);
  }
});

test("credential transition refuses an inbox swapped after the final signed precheck", (t) => {
  const fix = fixture(t);
  writeFileSync(fix.paths.inbox, `SUPABASE_SERVICE_ROLE_KEY=${thirdCredential}\n`);
  chmodSync(fix.paths.inbox, 0o600);
  assert.throws(
    () => transition(fix),
    (error) => error instanceof TransitionError && error.code === "precheck_candidate_digest_mismatch",
  );
  assert.equal(readFileSync(fix.paths.inbox, "utf8"), `SUPABASE_SERVICE_ROLE_KEY=${thirdCredential}\n`);
  assert.equal(existsSync(fix.paths.pending), false);
  assert.equal(existsSync(fix.paths.backup), false);
  assert.match(readFileSync(fix.paths.runtime, "utf8"), new RegExp(oldCredential));
});

test("format-only runtime changes cannot consume a same-value credential replacement", (t) => {
  const variants = [
    [
      `NEWME_READINESS_TOKEN=${"c".repeat(64)}`,
      "NEXT_PUBLIC_SITE_URL=https://app.newme.ae",
      `SUPABASE_SERVICE_ROLE_KEY=${oldCredential}`,
      "UNRELATED_RUNTIME_SETTING=preserved",
      "",
    ].join("\n"),
    [
      `export SUPABASE_SERVICE_ROLE_KEY = \"${oldCredential}\"`,
      "UNRELATED_RUNTIME_SETTING=preserved",
      `NEWME_READINESS_TOKEN=${"c".repeat(64)}`,
      "NEXT_PUBLIC_SITE_URL=https://app.newme.ae",
      "",
    ].join("\r\n"),
    [
      "UNRELATED_RUNTIME_SETTING=preserved",
      `SUPABASE_SERVICE_ROLE_KEY = '${oldCredential}'`,
      "NEXT_PUBLIC_SITE_URL=https://app.newme.ae",
      `NEWME_READINESS_TOKEN=${"c".repeat(64)}`,
      "",
    ].join("\n"),
  ];
  for (const runtime of variants) {
    const fix = fixture(t);
    writeFileSync(fix.paths.runtime, runtime);
    writeFileSync(fix.paths.inbox, `SUPABASE_SERVICE_ROLE_KEY=${oldCredential}\n`);
    const beforeRuntime = readFileSync(fix.paths.runtime, "utf8");
    const beforeInbox = readFileSync(fix.paths.inbox, "utf8");
    assert.throws(
      () => transition(fix),
      (error) => error instanceof TransitionError && error.code === "replacement_matches_current_service_key",
    );
    assert.equal(readFileSync(fix.paths.runtime, "utf8"), beforeRuntime);
    assert.equal(readFileSync(fix.paths.inbox, "utf8"), beforeInbox);
    assert.equal(fix.calls.validate, 0);
    assert.equal(fix.calls.restart, 0);
    for (const absent of [fix.paths.pending, fix.paths.backup, fix.paths.runtimeNext, fix.paths.last]) {
      assert.equal(existsSync(absent), false, `${absent} must remain absent`);
    }
  }
});

test("direct apply refuses and preserves a replaced one-use inbox after the healthy checkpoint", (t) => {
  const fix = fixture(t);
  const replacement = `sb_secret_${"x".repeat(48)}`;
  assert.throws(() => transition(fix, {
    checkpoint(name) {
      if (name === "after_healthy_record") {
        writeFileSync(fix.paths.inbox, `SUPABASE_SERVICE_ROLE_KEY=${replacement}\n`);
        chmodSync(fix.paths.inbox, 0o600);
      }
    },
  }), /inbox_candidate_digest_mismatch/);
  assert.equal(existsSync(fix.paths.pending), true);
  assert.equal(existsSync(fix.paths.inbox), true);
  assert.match(readFileSync(fix.paths.inbox, "utf8"), new RegExp(replacement));
});

test("healthy recovery refuses and preserves an inbox replaced after interruption", (t) => {
  const fix = fixture(t);
  assert.throws(() => transition(fix, {
    checkpoint(name) {
      if (name === "after_healthy_record") throw new Error("simulated healthy interruption");
    },
  }), /simulated healthy interruption/);
  const replacement = `sb_secret_${"y".repeat(48)}`;
  writeFileSync(fix.paths.inbox, `SUPABASE_SERVICE_ROLE_KEY=${replacement}\n`);
  chmodSync(fix.paths.inbox, 0o600);
  assert.throws(() => recovery(fix), /inbox_candidate_digest_mismatch/);
  assert.equal(existsSync(fix.paths.pending), true);
  assert.equal(existsSync(fix.paths.inbox), true);
  assert.match(readFileSync(fix.paths.inbox, "utf8"), new RegExp(replacement));
});

test("healthy recovery rechecks runtime and inbox after restart verification", (t) => {
  for (const [mutatedPath, expectedCode] of [
    ["inbox", "inbox_candidate_digest_mismatch"],
    ["runtime", "runtime_candidate_digest_mismatch"],
  ]) {
    const fix = fixture(t);
    assert.deepEqual(transition(fix), { status: "awaiting_provider_revocation" });
    assert.throws(
      () => recovery(fix, {
        restartAndVerify() {
          if (mutatedPath === "inbox") {
            writeFileSync(fix.paths.inbox, `SUPABASE_SERVICE_ROLE_KEY=${thirdCredential}\n`);
          } else {
            writeFileSync(fix.paths.runtime, `SUPABASE_SERVICE_ROLE_KEY=${thirdCredential}\n`);
          }
        },
      }),
      (error) => error instanceof TransitionError && error.code === expectedCode,
    );
    for (const preserved of [fix.paths.pending, fix.paths.backup, fix.paths.inbox]) {
      assert.equal(existsSync(preserved), true, `${preserved} must remain recoverable`);
    }
  }
});

test("restart failure automatically restores the prior runtime and preserves the inbox", (t) => {
  const fix = fixture(t);
  let restarts = 0;
  assert.throws(
    () => transition(fix, {
      restartAndVerify() {
        restarts += 1;
        if (restarts === 1) throw new Error("fixture restart failure");
      },
    }),
    (error) => error instanceof TransitionError && error.code === "service_verification_failed_rolled_back",
  );
  const runtime = readFileSync(fix.paths.runtime, "utf8");
  assert.match(runtime, new RegExp(oldCredential));
  assert.doesNotMatch(runtime, new RegExp(newCredential));
  assert.equal(restarts, 2);
  assert.equal(existsSync(fix.paths.inbox), true);
  assert.equal(existsSync(fix.paths.pending), false);
  assert.equal(existsSync(fix.paths.backup), false);
  const last = readFileSync(fix.paths.last, "utf8");
  assert.equal(JSON.parse(last).status, "rolled_back");
  assertNoCredential(last);
});

test("recover rolls back an interruption between runtime rename and phase update", (t) => {
  const fix = fixture(t);
  assert.throws(() => transition(fix, {
    checkpoint(name) {
      if (name === "after_runtime_switch") throw new Error("simulated interruption");
    },
  }), /simulated interruption/);
  assert.match(readFileSync(fix.paths.runtime, "utf8"), new RegExp(newCredential));
  assert.equal(JSON.parse(readFileSync(fix.paths.pending, "utf8")).phase, "prepared");

  assert.deepEqual(recovery(fix), { status: "rolled_back" });
  assert.match(readFileSync(fix.paths.runtime, "utf8"), new RegExp(oldCredential));
  assert.equal(existsSync(fix.paths.inbox), true);
  assert.equal(existsSync(fix.paths.pending), false);
  assert.equal(existsSync(fix.paths.backup), false);
});

test("recover removes a pre-pending backup left by interruption", (t) => {
  const fix = fixture(t);
  assert.throws(() => transition(fix, {
    checkpoint(name) {
      if (name === "after_backup") throw new Error("simulated pre-pending interruption");
    },
  }), /simulated pre-pending interruption/);
  assert.equal(existsSync(fix.paths.pending), false);
  assert.equal(existsSync(fix.paths.backup), true);
  assert.equal(existsSync(fix.paths.runtimeNext), true);

  assert.deepEqual(recovery(fix), { status: "none" });
  assert.equal(existsSync(fix.paths.backup), false);
  assert.equal(existsSync(fix.paths.runtimeNext), false);
  assert.equal(existsSync(fix.paths.inbox), true);
  assert.match(readFileSync(fix.paths.runtime, "utf8"), new RegExp(oldCredential));
});

test("recover preserves a healthy cutover interrupted after the awaiting-provider record", (t) => {
  const fix = fixture(t);
  assert.throws(() => transition(fix, {
    checkpoint(name) {
      if (name === "after_awaiting_provider_record") throw new Error("simulated interruption");
    },
  }), /simulated interruption/);
  assert.equal(existsSync(fix.paths.inbox), true);
  assert.equal(JSON.parse(readFileSync(fix.paths.pending, "utf8")).phase, "awaiting_provider_revocation");

  assert.deepEqual(recovery(fix), { status: "awaiting_provider_revocation" });
  assert.match(readFileSync(fix.paths.runtime, "utf8"), new RegExp(newCredential));
  assert.equal(existsSync(fix.paths.pending), true);
  assert.equal(existsSync(fix.paths.backup), true);
  assert.equal(existsSync(fix.paths.inbox), true);
  assert.equal(JSON.parse(readFileSync(fix.paths.last, "utf8")).status, "awaiting_provider_revocation");
});

test("a healthy cutover that later rolls back restores the exact prior protection marker", (t) => {
  for (const prior of [null, `${JSON.stringify({
    version: 1,
    candidate_sha: "d".repeat(40),
    activated_at: "2026-08-13T00:00:00.000Z",
  })}\n`]) {
    const fix = fixture(t);
    if (prior !== null) {
      writeFileSync(fix.paths.protection, prior);
      chmodSync(fix.paths.protection, 0o600);
    }
    assert.throws(() => transition(fix, {
      checkpoint(name) {
        if (name === "after_protection_written") throw new Error("simulated post-protection interruption");
      },
    }), /simulated post-protection interruption/);
    assert.equal(JSON.parse(readFileSync(fix.paths.protection, "utf8")).candidate_sha, sha);

    let restartCalls = 0;
    assert.deepEqual(recovery(fix, {
      restartAndVerify() {
        restartCalls += 1;
        if (restartCalls === 1) throw new Error("health regressed after marker write");
      },
    }), { status: "rolled_back" });
    if (prior === null) {
      assert.equal(existsSync(fix.paths.protection), false);
    } else {
      assert.equal(readFileSync(fix.paths.protection, "utf8"), prior);
    }
    assert.equal(JSON.parse(readFileSync(fix.paths.last, "utf8")).status, "rolled_back");
  }
});

test("recovery never removes provider-revocation inputs or the old identity backup", (t) => {
  const fix = fixture(t);
  assert.deepEqual(transition(fix), { status: "awaiting_provider_revocation" });
  assert.deepEqual(recovery(fix), { status: "awaiting_provider_revocation" });
  assert.equal(existsSync(fix.paths.pending), true);
  assert.equal(existsSync(fix.paths.backup), true);
  assert.equal(existsSync(fix.paths.inbox), true);
  assert.equal(JSON.parse(readFileSync(fix.paths.last, "utf8")).status, "awaiting_provider_revocation");
  assert.match(readFileSync(fix.paths.runtime, "utf8"), new RegExp(newCredential));
});

test("healthy recovery remains awaiting provider proof across repeated reentry", (t) => {
  const fix = fixture(t);
  assert.throws(() => transition(fix, {
    checkpoint(name) {
      if (name === "after_healthy_record") throw new Error("simulated healthy interruption");
    },
  }), /simulated healthy interruption/);

  assert.deepEqual(recovery(fix), { status: "awaiting_provider_revocation" });
  assert.equal(existsSync(fix.paths.pending), true);
  assert.equal(existsSync(fix.paths.backup), true);
  assert.equal(existsSync(fix.paths.inbox), true);
  assert.match(readFileSync(fix.paths.runtime, "utf8"), new RegExp(newCredential));

  assert.deepEqual(recovery(fix), { status: "awaiting_provider_revocation" });
  assert.equal(existsSync(fix.paths.backup), true);
  assert.match(readFileSync(fix.paths.runtime, "utf8"), new RegExp(newCredential));
});

test("failed recovery leaves a durable non-secret blocker and backup", (t) => {
  const fix = fixture(t);
  assert.throws(() => transition(fix, {
    checkpoint(name) {
      if (name === "after_runtime_switch") throw new Error("simulated interruption");
    },
  }), /simulated interruption/);

  assert.throws(
    () => recovery(fix, { restartAndVerify() { throw new Error("still down"); } }),
    (error) => error instanceof TransitionError && error.code === "credential_recovery_failed",
  );
  assert.equal(existsSync(fix.paths.backup), true);
  const pending = readFileSync(fix.paths.pending, "utf8");
  assert.equal(JSON.parse(pending).phase, "recovery_failed");
  assertNoCredential(pending);
});

test("malformed inbox and conflicting orphan backup fail closed", (t) => {
  const malformed = fixture(t);
  writeFileSync(malformed.paths.inbox, `SUPABASE_SERVICE_ROLE_KEY=${newCredential}\nEXTRA=forbidden\n`);
  assert.throws(
    () => transition(malformed),
    (error) => error instanceof TransitionError && error.code === "inbox_invalid",
  );
  assert.match(readFileSync(malformed.paths.runtime, "utf8"), new RegExp(oldCredential));

  const orphan = fixture(t);
  writeFileSync(orphan.paths.backup, "conflicting-root-owned-backup\n");
  assert.throws(
    () => transition(orphan),
    (error) => error instanceof TransitionError && error.code === "orphan_backup_requires_live_completion",
  );
  assert.match(readFileSync(orphan.paths.runtime, "utf8"), new RegExp(oldCredential));

  const historicalComplete = fixture(t);
  writeFileSync(historicalComplete.paths.backup, `SUPABASE_SERVICE_ROLE_KEY=${newCredential}\n`);
  writeFileSync(historicalComplete.paths.last, `${JSON.stringify({
    version: 1,
    status: "complete",
    candidate_sha: sha,
    ci_run_id: runId,
    finished_at: "2026-08-15T00:00:00.000Z",
    before_sha256: "1".repeat(64),
    after_sha256: "2".repeat(64),
  })}\n`);
  assert.throws(
    () => recovery(historicalComplete),
    (error) => error instanceof TransitionError && error.code === "orphan_backup_requires_live_completion",
  );
  assert.equal(existsSync(historicalComplete.paths.backup), true);

  const stray = fixture(t);
  writeFileSync(join(stray.paths.inboxDir, "unexpected-file"), "not accepted\n");
  assert.throws(
    () => transition(stray),
    (error) => error instanceof TransitionError && error.code === "inbox_directory_not_single_use",
  );
});

test("credential apply refuses unresolved deploy, credential-asset, and production rollback transactions", (t) => {
  for (const field of ["systemdPending", "credentialAssetsPending", "productionRollbackPending"]) {
    const fix = fixture(t);
    writeFileSync(fix.paths[field], "unresolved fixture\n");
    assert.throws(
      () => transition(fix),
      (error) => error instanceof TransitionError &&
        error.code === "another_release_transaction_requires_recovery",
    );
    assert.match(readFileSync(fix.paths.runtime, "utf8"), new RegExp(oldCredential));
    assert.equal(existsSync(fix.paths.inbox), true);
  }
});

test("metadata checks reject symlinks, non-root ownership, and broad modes", () => {
  const metadata = ({ symlink = false, uid = 0, gid = 0, mode = 0o100600 } = {}) => ({
    uid,
    gid,
    mode,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => symlink,
  });
  const spec = { kind: "file", modes: [0o600], label: "fixture" };
  assert.throws(() => assertMetadata(metadata({ symlink: true }), spec), /fixture_type_invalid/);
  assert.throws(() => assertMetadata(metadata({ uid: 1000 }), spec), /fixture_ownership_invalid/);
  assert.throws(() => assertMetadata(metadata({ mode: 0o100644 }), spec), /fixture_mode_invalid/);
});

test("service unit contract accepts one fixed runtime file and rejects drift", () => {
  assert.doesNotThrow(() => assertFixedRuntimeEnvironmentFile([
    "[Service]",
    "EnvironmentFile=/etc/newme/newme-runtime.env",
    "",
  ].join("\n")));
  for (const unit of [
    "[Service]\n",
    "[Service]\nEnvironmentFile=/tmp/override.env\n",
    "[Service]\nEnvironmentFile=/etc/newme/newme-runtime.env\nEnvironmentFile=/tmp/extra.env\n",
  ]) {
    assert.throws(
      () => assertFixedRuntimeEnvironmentFile(unit),
      (error) => error instanceof TransitionError && error.code === "service_unit_runtime_store_invalid",
    );
  }
});

test("credential control plane has no secret argument, environment, stdin, or database URL channel", () => {
  const helper = readFileSync(join(repository, "scripts", "credential-transition.mjs"), "utf8");
  const immutable = readFileSync(join(repository, "scripts", "deploy-immutable.sh"), "utf8");
  const crmRegression = readFileSync(join(repository, "scripts", "crm-regression.py"), "utf8");
  const installer = readFileSync(join(repository, "scripts", "install-systemd-assets.sh"), "utf8");
  const assetRollback = readFileSync(join(repository, "scripts", "rollback-systemd-assets.sh"), "utf8");
  const productionRollback = readFileSync(
    join(repository, "infra", "systemd", "newme-production-rollback.sh"),
    "utf8",
  );
  const validator = readFileSync(join(repository, "scripts", "validate-production-config.py"), "utf8");
  const unit = readFileSync(join(repository, "infra", "systemd", "newme-platform.service"), "utf8");
  const dependencyProbe = readFileSync(
    join(repository, "infra", "observability", "dependency-probe.sh"),
    "utf8",
  );
  const observabilityCron = readFileSync(
    join(repository, "infra", "observability", "newme-observability.cron"),
    "utf8",
  );

  assert.match(helper, /runtime: "\/etc\/newme\/newme-runtime\.env"/);
  assert.match(helper, /unit: "\/etc\/systemd\/system\/newme-platform\.service"/);
  assert.match(helper, /inbox: "\/run\/newme-credential-inbox\/supabase-service-key\.env"/);
  assert.doesNotMatch(helper, /process\.env|process\.stdin|migration-db\.url/);
  assert.match(helper, /stdio: "ignore"/);
  assert.match(helper, /--property=FragmentPath/);
  assert.match(helper, /--property=DropInPaths/);
  assert.match(helper, /EnvironmentFile=\/etc\/newme\/newme-runtime\.env/);
  assert.match(helper, /PRODUCTION_LOCK = "\/run\/lock\/newme-production-release\.lock"/);
  assert.match(helper, /argv\[0\] === "apply" && argv\.length === 8/);
  assert.match(helper, /transitionAfterSha256: argv\[7\]/);
  assert.match(helper, /argv\[0\] === "recover" && argv\.length === 1/);
  assert.match(unit, /^EnvironmentFile=\/etc\/newme\/newme-runtime\.env$/m);
  assert.match(immutable, /SUPABASE_SERVICE_ROLE_KEY[\s\S]*--require-runtime-service-key[\s\S]*--require-no-release-service-key/);
  assert.match(immutable, /readonly RUNTIME_ENV=\/etc\/newme\/newme-runtime\.env/);
  assert.match(immutable, /CRM_RUNTIME_ENV_FILE="\$RUNTIME_ENV"[\s\S]*deploy-verify\.sh" --no-git/);
  assert.match(crmRegression, /release environment must not contain SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(crmRegression, /process_env\.get\("SUPABASE_SERVICE_ROLE_KEY"\) or runtime_env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/);
  assert.doesNotMatch(immutable, /install -m 0600 "\$PREVIOUS\/\.env\.local"/);
  assert.doesNotMatch(
    installer,
    /do remember "\$p"; done[^\n]*\/etc\/newme\/newme-runtime\.env/,
  );
  assert.match(
    installer,
    /\[ -e "\$CREDENTIAL_TRANSITION_PENDING" \] \|\| \[ -L "\$CREDENTIAL_TRANSITION_PENDING" \]/,
  );
  assert.match(assetRollback, /is_credential_protected_asset "\$dest" && continue/);
  assert.match(assetRollback, /credential-remediation\.protected\.json/);
  assert.match(assetRollback, /verify_credential_protected_assets/);
  assert.match(
    assetRollback,
    /\[ -e "\$CREDENTIAL_TRANSITION_PENDING" \] \|\| \[ -L "\$CREDENTIAL_TRANSITION_PENDING" \]/,
  );
  assert.match(assetRollback, /newme-deploy credential-recover/);
  assert.match(productionRollback, /exec 9>\/run\/lock\/newme-production-release\.lock/);
  assert.match(
    productionRollback,
    /\[ -e "\$CREDENTIAL_TRANSITION_PENDING" \] \|\| \[ -L "\$CREDENTIAL_TRANSITION_PENDING" \]/,
  );
  assert.match(productionRollback, /newme-deploy credential-recover/);
  assert.match(dependencyProbe, /readonly RUNTIME_ENV=\/etc\/newme\/newme-runtime\.env/);
  assert.match(dependencyProbe, /stat -c '%U:%G' "\$RUNTIME_ENV"/);
  assert.match(dependencyProbe, /stat -c '%a' "\$RUNTIME_ENV"/);
  assert.doesNotMatch(dependencyProbe, /read_env_value "\$RELEASE_ENV" SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(
    observabilityCron,
    /^\*\/2 \* \* \* \* root \/usr\/bin\/flock -n \/run\/lock\/newme-observability-l0\.lock /m,
  );
  assert.match(validator, /--require-runtime-service-key/);
  assert.match(validator, /--require-no-release-service-key/);
});

test("canonical wrapper binds the dedicated CI gate to a durable credential-only asset transaction", () => {
  const wrapper = readFileSync(join(repository, "infra", "systemd", "newme-deploy.sh"), "utf8");
  const installer = readFileSync(join(repository, "scripts", "install-systemd-assets.sh"), "utf8");
  const verifier = readFileSync(join(repository, "scripts", "verify-credential-remediation-ci.mjs"), "utf8");
  const bootstrapStart = wrapper.indexOf("credential-trust-bootstrap)");
  const transitionStart = wrapper.indexOf("credential-transition)");
  const recoveryStart = wrapper.indexOf("credential-recover)", transitionStart);
  assert.ok(bootstrapStart > 0 && transitionStart > bootstrapStart && recoveryStart > transitionStart);

  const bootstrapBranch = wrapper.slice(bootstrapStart, transitionStart);
  assert.match(bootstrapBranch, /require_canonical_main_sha "\$CREDENTIAL_SHA"/);
  assert.equal((bootstrapBranch.match(/verify_credential_ci_live/g) ?? []).length, 2);
  assert.match(bootstrapBranch, /check-taskboard\.mjs --require-credential-remediation/);
  assert.match(bootstrapBranch, /run_attempt=\$CREDENTIAL_RUN_ATTEMPT/);
  assert.match(bootstrapBranch, /mode=credential_remediation/);
  assert.match(bootstrapBranch, /gate=credential-assets-only/);
  assert.match(bootstrapBranch, /credential-install/);
  assert.match(bootstrapBranch, /credential-finalize/);
  assert.match(bootstrapBranch, /require_installed_credential_attestor_for_sha "\$CREDENTIAL_SHA"/);
  assert.doesNotMatch(bootstrapBranch, /newme-credential-transition\.mjs apply/);

  const transitionBranch = wrapper.slice(transitionStart, recoveryStart);
  assert.match(transitionBranch, /require_canonical_main_sha "\$CREDENTIAL_SHA"/);
  assert.equal((transitionBranch.match(/verify_credential_ci_live/g) ?? []).length, 2);
  assert.match(transitionBranch, /check-taskboard\.mjs --require-credential-remediation/);
  assert.doesNotMatch(transitionBranch, /mode=credential_remediation|gate=credential-assets-only|credential-install|credential-finalize/);
  const providerMaterialization = transitionBranch.indexOf("credential_live_exec materialize-provider");
  const precheckProduction = transitionBranch.indexOf("credential_live_exec prepare");
  const transitionApply = transitionBranch.indexOf("credential_transition_exec apply");
  assert.ok(
    providerMaterialization > 0 && precheckProduction > providerMaterialization && transitionApply > precheckProduction,
    "provider-bound materialization must complete before precheck and cutover",
  );
  assert.match(transitionBranch, /provider-bound credential materialization was refused/);
  assert.match(transitionBranch, /provider_identity_receipt_sha256/);
  assert.match(transitionBranch, /verify_credential_precheck_live/);
  assert.match(
    transitionBranch,
    /credential_transition_exec apply \\\s*\n\s*"\$CREDENTIAL_SHA" "\$CREDENTIAL_RUN_ID" "\$CREDENTIAL_RUN_ATTEMPT" "\$CREDENTIAL_TRANSACTION_ID" \\\s*\n\s*"\$CREDENTIAL_PRECHECK_SHA256" "\$CREDENTIAL_TRANSITION_BEFORE_SHA256" \\\s*\n\s*"\$CREDENTIAL_TRANSITION_AFTER_SHA256"/,
  );
  assert.match(wrapper, /hardened_node_exec\(\)[\s\S]*resource\.setrlimit\(resource\.RLIMIT_CORE, \(0, 0\)\)[\s\S]*libc\.prctl\(4, 0, 0, 0, 0\)[\s\S]*os\.execve\(node, \[node, helper, \*arguments\], environment\)/);
  assert.match(wrapper, /credential_transition_exec\(\)[\s\S]*hardened_node_exec "\$CREDENTIAL_TRANSITION_HELPER" "\$@"/);
  assert.match(transitionBranch, /credential_transition_exec apply/);
  assert.doesNotMatch(transitionBranch, /"\$CREDENTIAL_TRANSITION_HELPER" apply|newme-credential-transition\.mjs apply/);
  assert.match(transitionBranch, /credential_transition=awaiting_provider_revocation/);
  assert.match(transitionBranch, /validate_credential_awaiting_state/);
  assert.match(transitionBranch, /dependency-probe\.sh >\/dev\/null/);
  assert.doesNotMatch(transitionBranch, /migration-db\.url|db-phase|deploy-immutable|nginx|newme-platform\.service" \/etc\/systemd/);

  const recoveryBranch = wrapper.slice(recoveryStart, wrapper.indexOf("\nesac", recoveryStart));
  assert.match(recoveryBranch, /wc -l < "\$CREDENTIAL_ASSET_PENDING"\)" -eq 8/);
  assert.match(recoveryBranch, /wc -l < "\$CREDENTIAL_GATE_CONSUMED"\)" -eq 9/);
  for (const field of ["version=1", "sha=", "run=", "run_attempt=", "gate_sha256=", "backup=", "phase=prepared", "mode=credential_remediation"]) {
    assert.ok(recoveryBranch.includes(field), `credential recovery omits pending field ${field}`);
  }
  assert.match(recoveryBranch, /credential_worktree_add "\$CREDENTIAL_RECOVERY_SHA"[\s\S]*install-systemd-assets\.sh" credential-recover/);
  assert.match(recoveryBranch, /credential_transition=awaiting_provider_revocation/);
  assert.match(recoveryBranch, /validate_credential_awaiting_state/);

  const drill = readFileSync(join(repository, "scripts", "credential-assets-transaction-drill.sh"), "utf8");
  assert.match(drill, /\/usr\/local\/sbin\/newme-deploy credential-recover/);
  assert.match(drill, /recovery clears pending[\s\S]*consumed gate record replayed after recovery/);

  assert.match(installer, /CREDENTIAL_ASSET_PENDING="\$STATE_ROOT\/credential-assets\.pending"/);
  assert.match(installer, /mode=credential_remediation/);
  assert.match(installer, /credential_install_cleanup/);
  assert.match(installer, /NEWME_CREDENTIAL_ASSET_RECOVERY=1/);
  const subsetStart = installer.indexOf("CREDENTIAL_SUBSET=(");
  const subsetEnd = installer.indexOf("\n)", subsetStart);
  const subset = installer.slice(subsetStart, subsetEnd);
  assert.match(subset, /newme-deploy/);
  assert.match(subset, /newme-credential-transition\.mjs/);
  assert.match(subset, /newme-validate-production-config\.py/);
  assert.match(subset, /newme-credential-inbox\.conf/);
  assert.match(subset, /dependency-probe\.sh/);
  assert.match(subset, /newme-observability/);
  assert.doesNotMatch(subset, /newme-platform\.service|nginx|migration/);
  assert.match(verifier, /required-skipped job/);
  assert.match(verifier, /run_started_at/);
  assert.match(verifier, /credential-remediation run is stale/);
});

test("credential runbook requires trust bootstrap before cutover and preserves the signed two-phase order", () => {
  const runbook = readFileSync(join(repository, "infra", "release", "credential-transition.md"), "utf8");
  const bootstrap = runbook.indexOf("credential-trust-bootstrap");
  const stampedBootstrap = runbook.indexOf("credential-trust-bootstrap <stamped-successor-main-sha>", bootstrap + 1);
  const transition = runbook.indexOf("credential-transition <main-sha>", bootstrap);
  const providerRevocation = runbook.indexOf("authorized Supabase owner must revoke", transition);
  const prove = runbook.indexOf("credential-prove-revocation", transition);
  const complete = runbook.indexOf("credential-complete", prove);
  const readback = runbook.indexOf("credential-live-readback", complete);
  const consume = runbook.indexOf("credential-live-consume", readback);

  assert.ok(
    bootstrap > 0 && stampedBootstrap > bootstrap && transition > stampedBootstrap &&
      providerRevocation > transition && prove > providerRevocation && complete > prove &&
      readback > complete && consume > readback,
    "runbook must preserve initial bootstrap -> stamped bootstrap -> transition -> revoke -> proof -> completion -> readback -> consume",
  );
  assert.match(runbook, /Re-run `receipt-key-inspect` and require both digests to remain equal to the\s+reviewed pins/);
  assert.match(runbook, /GitHub alerts #1 and #2 remain open/);
  assert.match(runbook, /Do not close either GitHub alert yet/);
  assert.match(runbook, /direct child of the\s+remediation SHA/);
  assert.match(runbook, /only changed path is `TASKBOARD\.md`/);
  assert.match(runbook, /`PROD-SECRET-SCANNING-ALERTS-OPEN` row must remain `BLOCKED`/);
  assert.match(runbook, /credential_remediation=true/);
  assert.match(runbook, /ordinary Predeploy job must remain skipped/);
  assert.match(runbook, /Only after successful consumption[\s\S]*change the\s+Secret Scanning row to `DONE`/);
  assert.match(runbook, /credential_transition=awaiting_provider_revocation/);
  assert.match(runbook, /pending record, and protected backup are present/);
  assert.match(runbook, /Only `credential-live-consume` may call the signed transition finalizer/);
  assert.doesNotMatch(runbook, /removes the one-use inbox, writes a\s+non-secret completion record, and removes the pending state and backup/);
  assert.doesNotMatch(runbook, /pending record, and protected backup are absent/);
});

test("legacy notification utilities cannot consume a Supabase personal access token", () => {
  for (const relative of [
    "scripts/apply_notification_related_types.cjs",
    "scripts/apply_notification_types.cjs",
  ]) {
    const file = join(repository, ...relative.split("/"));
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /SUPABASE_PAT|api\.supabase\.com|Authorization|process\.env/);
    const result = spawnSync(process.execPath, [file], { encoding: "utf8" });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /retired utility/);
  }
});

test("retired manual server credential consumers fail closed", () => {
  for (const relative of [
    "scripts/apply_notifications_migration.cjs",
    "scripts/apply_migrations_0604.cjs",
    "scripts/crm-daily-report.js",
    "scripts/fix-null-names.py",
  ]) {
    const file = join(repository, ...relative.split("/"));
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /SUPABASE_SERVICE_ROLE_KEY|process\.env|dotenv|createClient|exec_sql|api\.supabase\.com/,
    );
    const executable = relative.endsWith(".py") ? "python3" : process.execPath;
    const result = spawnSync(executable, [file], { encoding: "utf8" });
    assert.equal(result.status, 64, `${relative} must fail closed`);
    assert.match(result.stderr, /retired utility/);
  }
});

// ---------------------------------------------------------------------------
// Service-key store adoption: relocation of the credential already in use into
// the fixed runtime store, which the deploy contract requires and which the
// rotation cannot perform (it needs a provider-issued replacement that does not
// exist here). A host stuck in the old shape -- key in the release environment,
// nothing in the store -- cannot deploy at all, because the deploy strips the
// key from the candidate environment and then fails its own validator.
// ---------------------------------------------------------------------------

function adoptFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "newme-credential-adopt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const inboxDir = join(root, "inbox");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(inboxDir, { mode: 0o700 });
  const runtime = join(root, "runtime.env");
  const releaseEnv = join(root, "release.env");
  // The production shape this operation exists for: a runtime store with real
  // settings but no service credential, and a live release that still carries it.
  writeFileSync(runtime, [
    `NEWME_READINESS_TOKEN=${"c".repeat(64)}`,
    "NEXT_PUBLIC_SITE_URL=https://app.newme.ae",
    "CABLE_COSTING_CONFIG={\"v\":1}",
    "",
  ].join("\n"));
  chmodSync(runtime, 0o600);
  writeFileSync(releaseEnv, [
    "NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co",
    `SUPABASE_SERVICE_ROLE_KEY=${oldCredential}`,
    "",
  ].join("\n"));
  chmodSync(releaseEnv, 0o600);

  const paths = {
    runtimeDir: root,
    runtime,
    runtimeNext: `${runtime}.next`,
    runtimeAdoptNext: `${runtime}.adopt.next`,
    inboxDir,
    inbox: join(inboxDir, "supabase-service-key.env"),
    stateDir,
    pending: join(stateDir, "pending.json"),
    pendingNext: join(stateDir, "pending.next"),
    systemdPending: join(stateDir, "systemd-assets.pending"),
    credentialAssetsPending: join(stateDir, "credential-assets.pending"),
    productionRollbackPending: join(stateDir, "production-rollback.pending"),
    backup: join(stateDir, "previous.env"),
    backupPreparing: join(stateDir, "previous.env.preparing"),
    last: join(stateDir, "last.json"),
    lastNext: join(stateDir, "last.next"),
    adoptPending: join(stateDir, "credential-adopt.pending.json"),
    adoptPendingNext: join(stateDir, "credential-adopt.pending.next"),
    adoptBackup: join(stateDir, "credential-adopt.previous.env"),
    adoptBackupPreparing: join(stateDir, "credential-adopt.previous.env.preparing"),
    adoptLast: join(stateDir, "credential-adopt.last.json"),
    adoptLastNext: join(stateDir, "credential-adopt.last.next"),
    protection: join(stateDir, "credential-remediation.protected.json"),
    protectionNext: join(stateDir, "credential-remediation.protected.next"),
    releaseEnv,
    validator: join(root, "validator.py"),
    readiness: join(root, "readiness.sh"),
    python: "python3",
    systemctl: "systemctl",
  };
  const calls = { validate: 0, restart: 0 };
  const options = {
    paths,
    securityChecks: false,
    durable: false,
    now: () => "2026-08-20T00:00:00.000Z",
    validateCandidate(candidate) {
      calls.validate += 1;
      // The candidate must carry the value the live release is already using,
      // and must not have lost the settings that were already in the store.
      const value = readFileSync(candidate, "utf8");
      assert.match(value, new RegExp(`SUPABASE_SERVICE_ROLE_KEY=${oldCredential}`));
      assert.match(value, /NEWME_READINESS_TOKEN=/);
      assert.match(value, /CABLE_COSTING_CONFIG=/);
    },
    restartAndVerify() {
      calls.restart += 1;
    },
  };
  return { root, paths, calls, options };
}

function adopt(fix, overrides = {}) {
  return adoptServiceKeyStore({ sha, ...fix.options, ...overrides });
}

function adoptRecovery(fix, overrides = {}) {
  return recoverServiceKeyAdoption({ ...fix.options, ...overrides });
}

function serviceKeyOf(path) {
  const match = readFileSync(path, "utf8").match(/^SUPABASE_SERVICE_ROLE_KEY=(.*)$/mu);
  return match === null ? null : match[1];
}

test("adoption relocates the live release credential into the fixed runtime store", (t) => {
  const fix = adoptFixture(t);
  const before = readFileSync(fix.paths.runtime, "utf8");
  assert.equal(adopt(fix).status, "complete");
  assert.equal(serviceKeyOf(fix.paths.runtime), oldCredential);
  // Everything the store already held survives, in place.
  for (const line of before.split("\n").filter(Boolean)) {
    assert.match(readFileSync(fix.paths.runtime, "utf8"), new RegExp(line.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
  // The validator ran on the candidate before any switch, and the service was
  // restarted and verified afterwards.
  assert.equal(fix.calls.validate, 1);
  assert.equal(fix.calls.restart, 1);
  // No transaction residue: a status probe must report "none" afterwards.
  for (const path of [
    fix.paths.adoptPending,
    fix.paths.adoptPendingNext,
    fix.paths.adoptBackup,
    fix.paths.adoptBackupPreparing,
    fix.paths.runtimeAdoptNext,
  ]) {
    assert.equal(existsSync(path), false, path);
  }
  const last = JSON.parse(readFileSync(fix.paths.adoptLast, "utf8"));
  assert.equal(last.kind, "service_key_store_adoption");
  assert.equal(last.status, "complete");
  assert.equal(last.candidate_sha, sha);
  // The journal is digests only. A record that echoed the value would turn a
  // 0600 state file into a second copy of the credential.
  assert.doesNotMatch(JSON.stringify(last), new RegExp(oldCredential));
  assert.equal(last.before_sha256, createHash("sha256").update(before).digest("hex"));
  assert.equal(
    last.after_sha256,
    createHash("sha256").update(readFileSync(fix.paths.runtime, "utf8")).digest("hex"),
  );
});

test("adoption refuses when a rotation is staged or already in flight", (t) => {
  const rotationInput = adoptFixture(t);
  // A staged replacement means the value in the release is about to stop being
  // the live one; relocating it would install the wrong credential.
  writeFileSync(rotationInput.paths.inbox, `SUPABASE_SERVICE_ROLE_KEY=${newCredential}\n`, { mode: 0o600 });
  assert.throws(() => adopt(rotationInput), (error) => error instanceof TransitionError &&
    /rotation_input_present/.test(error.message));
  assert.equal(serviceKeyOf(rotationInput.paths.runtime), null);

  const rotationPending = adoptFixture(t);
  writeFileSync(rotationPending.paths.pending, "{}\n", { mode: 0o600 });
  assert.throws(() => adopt(rotationPending), (error) => error instanceof TransitionError &&
    /pending_transition_requires_recovery/.test(error.message));

  const releasePending = adoptFixture(t);
  writeFileSync(releasePending.paths.productionRollbackPending, "x\n", { mode: 0o600 });
  assert.throws(() => adopt(releasePending), (error) => error instanceof TransitionError &&
    /another_release_transaction_requires_recovery/.test(error.message));
});

test("adoption refuses inputs that make relocation meaningless or ambiguous", (t) => {
  const already = adoptFixture(t);
  writeFileSync(
    already.paths.runtime,
    `${readFileSync(already.paths.runtime, "utf8")}SUPABASE_SERVICE_ROLE_KEY=${oldCredential}\n`,
    { mode: 0o600 },
  );
  // Nothing to relocate, and overwriting a store that already has a credential
  // is the rotation's job, under the rotation's evidence.
  assert.throws(() => adopt(already), (error) => error instanceof TransitionError &&
    /runtime_service_key_already_present/.test(error.message));

  const missing = adoptFixture(t);
  writeFileSync(missing.paths.releaseEnv, "NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co\n", { mode: 0o600 });
  assert.throws(() => adopt(missing), (error) => error instanceof TransitionError &&
    /release_service_key_missing/.test(error.message));

  const duplicate = adoptFixture(t);
  writeFileSync(
    duplicate.paths.releaseEnv,
    `SUPABASE_SERVICE_ROLE_KEY=${oldCredential}\nexport SUPABASE_SERVICE_ROLE_KEY=${thirdCredential}\n`,
    { mode: 0o600 },
  );
  assert.throws(() => adopt(duplicate), (error) => error instanceof TransitionError &&
    /release_service_key_duplicate/.test(error.message));

  const malformed = adoptFixture(t);
  writeFileSync(malformed.paths.releaseEnv, "SUPABASE_SERVICE_ROLE_KEY=short\n", { mode: 0o600 });
  assert.throws(() => adopt(malformed), (error) => error instanceof TransitionError &&
    /release_environment_service_key_invalid/.test(error.message));

  for (const fix of [already, missing, duplicate, malformed]) {
    assert.equal(existsSync(fix.paths.adoptPending), false);
    assert.equal(existsSync(fix.paths.adoptBackup), false);
    assert.equal(existsSync(fix.paths.runtimeAdoptNext), false);
  }
});

test("adoption refuses a candidate the validator rejects, before switching anything", (t) => {
  const fix = adoptFixture(t);
  const before = readFileSync(fix.paths.runtime, "utf8");
  assert.throws(() => adopt(fix, {
    validateCandidate() {
      throw new Error("validator said no");
    },
  }), (error) => error instanceof TransitionError && /candidate_config_validation_failed/.test(error.message));
  assert.equal(readFileSync(fix.paths.runtime, "utf8"), before);
  assert.equal(fix.calls.restart, 0);
  // The staged candidate is the only place the credential was written; it must
  // not survive a refusal.
  assert.equal(existsSync(fix.paths.runtimeAdoptNext), false);
  assert.equal(existsSync(fix.paths.adoptBackup), false);
  assert.equal(existsSync(fix.paths.adoptPending), false);
});

test("a service that will not come back healthy is rolled back to the keyless store", (t) => {
  const fix = adoptFixture(t);
  const before = readFileSync(fix.paths.runtime, "utf8");
  let attempts = 0;
  assert.throws(() => adopt(fix, {
    restartAndVerify() {
      attempts += 1;
      if (attempts === 1) throw new Error("readiness failed");
    },
  }), (error) => error instanceof TransitionError &&
    /service_verification_failed_rolled_back/.test(error.message));
  assert.equal(attempts, 2);
  assert.equal(readFileSync(fix.paths.runtime, "utf8"), before);
  assert.equal(serviceKeyOf(fix.paths.runtime), null);
  assert.equal(JSON.parse(readFileSync(fix.paths.adoptLast, "utf8")).status, "rolled_back");
  assert.equal(existsSync(fix.paths.adoptPending), false);
  assert.equal(existsSync(fix.paths.adoptBackup), false);
});

test("a rollback that cannot restart the service stays open for recovery", (t) => {
  const fix = adoptFixture(t);
  assert.throws(() => adopt(fix, {
    restartAndVerify() {
      throw new Error("dead either way");
    },
  }), (error) => error instanceof TransitionError && /adopt_recovery_failed/.test(error.message));
  // Refusing to declare a state it could not verify is the point: the journal
  // and the preserved store both remain for the operator.
  const pending = JSON.parse(readFileSync(fix.paths.adoptPending, "utf8"));
  assert.equal(pending.phase, "recovery_failed");
  assert.equal(existsSync(fix.paths.adoptBackup), true);
  assert.equal(existsSync(fix.paths.adoptLast), false);
});

test("adoption interrupted after the runtime switch is completed by recovery", (t) => {
  const fix = adoptFixture(t);
  assert.throws(() => adopt(fix, {
    checkpoint(stage) {
      if (stage === "after_switched_record") throw new Error("power loss");
    },
  }), /power loss/);
  assert.equal(serviceKeyOf(fix.paths.runtime), oldCredential);
  assert.equal(JSON.parse(readFileSync(fix.paths.adoptPending, "utf8")).phase, "runtime_switched");

  assert.equal(adoptRecovery(fix).status, "complete");
  assert.equal(serviceKeyOf(fix.paths.runtime), oldCredential);
  assert.equal(JSON.parse(readFileSync(fix.paths.adoptLast, "utf8")).status, "complete");
  assert.equal(existsSync(fix.paths.adoptPending), false);
  assert.equal(existsSync(fix.paths.adoptBackup), false);
});

test("adoption interrupted before the runtime switch is closed without changing the store", (t) => {
  const fix = adoptFixture(t);
  const before = readFileSync(fix.paths.runtime, "utf8");
  assert.throws(() => adopt(fix, {
    checkpoint(stage) {
      if (stage === "after_pending") throw new Error("power loss");
    },
  }), /power loss/);
  assert.equal(adoptRecovery(fix).status, "interrupted_before_switch");
  assert.equal(readFileSync(fix.paths.runtime, "utf8"), before);
  assert.equal(JSON.parse(readFileSync(fix.paths.adoptLast, "utf8")).status, "interrupted_before_switch");
  assert.equal(existsSync(fix.paths.runtimeAdoptNext), false);
});

test("recovery rolls back when the interrupted run had already failed its restart", (t) => {
  const fix = adoptFixture(t);
  assert.throws(() => adopt(fix, {
    restartAndVerify() {
      throw new Error("dead either way");
    },
  }), (error) => error instanceof TransitionError && /adopt_recovery_failed/.test(error.message));
  // The service is repaired by other means; recovery must now finish the story
  // rather than leave the transaction open forever.
  assert.equal(adoptRecovery(fix).status, "rolled_back");
  assert.equal(serviceKeyOf(fix.paths.runtime), null);
  assert.equal(existsSync(fix.paths.adoptPending), false);
});

test("recovery is a no-op with nothing pending, and refuses states it cannot attribute", (t) => {
  const clean = adoptFixture(t);
  assert.equal(adoptRecovery(clean).status, "none");

  const orphan = adoptFixture(t);
  writeFileSync(orphan.paths.adoptBackup, "SOMETHING=1\n", { mode: 0o600 });
  assert.throws(() => adoptRecovery(orphan), (error) => error instanceof TransitionError &&
    /orphan_adoption_backup_requires_operator/.test(error.message));
  // The preserved copy is never destroyed by a guess.
  assert.equal(existsSync(orphan.paths.adoptBackup), true);

  const drifted = adoptFixture(t);
  assert.throws(() => adopt(drifted, {
    checkpoint(stage) {
      if (stage === "after_switched_record") throw new Error("power loss");
    },
  }), /power loss/);
  writeFileSync(drifted.paths.runtime, "EDITED_BY_HAND=1\n", { mode: 0o600 });
  assert.throws(() => adoptRecovery(drifted), (error) => error instanceof TransitionError &&
    /runtime_digest_unrecognized/.test(error.message));

  const tampered = adoptFixture(t);
  assert.throws(() => adopt(tampered, {
    checkpoint(stage) {
      if (stage === "after_switched_record") throw new Error("power loss");
    },
  }), /power loss/);
  writeFileSync(tampered.paths.adoptPending, "{\"version\":1}\n", { mode: 0o600 });
  assert.throws(() => adoptRecovery(tampered), (error) => error instanceof TransitionError &&
    /adopt_pending_invalid/.test(error.message));
});

test("the coordinator exposes adoption as its own subcommand pair", () => {
  const wrapper = readFileSync(join(repository, "infra", "systemd", "newme-deploy.sh"), "utf8");
  assert.match(wrapper, /^credential-adopt\)$/mu);
  assert.match(wrapper, /^credential-adopt-recover\)$/mu);
  // Adoption must be blocked by exactly the same unresolved-transaction set as
  // the rotation, plus the rotation's own staging files and its one-use input.
  const block = wrapper.slice(wrapper.indexOf("\ncredential-adopt)"), wrapper.indexOf("\ncredential-adopt-recover)"));
  for (const blocker of [
    "PENDING_ASSET_RECORD",
    "CREDENTIAL_ASSET_PENDING",
    "CREDENTIAL_GATE_CONSUMED",
    "CREDENTIAL_TRANSITION_PENDING",
    "TRANSITION_BACKUP_RECORD",
    "CREDENTIAL_INBOX",
    "PRODUCTION_ROLLBACK_PENDING",
    "CREDENTIAL_ADOPT_PENDING",
    "CREDENTIAL_ADOPT_BACKUP",
    "CREDENTIAL_ADOPT_RUNTIME_NEXT",
  ]) {
    assert.match(block, new RegExp(`\\$${blocker}"`), blocker);
  }
  // It only accepts canonical main, and re-verifies the release pointer, the
  // service, readiness, and the full deploy-contract validator afterwards.
  assert.match(block, /require_canonical_main_sha/);
  assert.match(block, /require_postdeploy_operations_clear/);
  assert.match(block, /--require-runtime-service-key --network/);
  assert.match(block, /newme-readiness\.sh/);
  assert.match(block, /credential_adopt=complete/);
  // No CI run id, no provider attestation, no gate consumption: this is a
  // relocation and must not be able to masquerade as remediation.
  assert.doesNotMatch(block, /credential_live_exec|verify_credential_ci_live|check-taskboard/);

  const rollback = readFileSync(join(repository, "infra", "systemd", "newme-production-rollback.sh"), "utf8");
  assert.match(rollback, /credential_adopt_transaction=%s/);
  assert.match(rollback, /credential_adopt_transaction=recovery_required/);
});

test("the installed adoption helper is the versioned one and refuses non-root use", () => {
  const helper = join(repository, "scripts", "credential-transition.mjs");
  const source = readFileSync(helper, "utf8");
  // The value must never become an argument: adopt takes a SHA only, and reads
  // the credential from a root-only file in process.
  assert.match(source, /argv\[0\] === "adopt" && argv\.length === 2/u);
  assert.match(source, /argv\[0\] === "adopt-recover" && argv\.length === 1/u);
  const result = spawnSync(process.execPath, [helper, "adopt", sha], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /SUPABASE_SERVICE_ROLE_KEY=/);
});
