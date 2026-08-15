// The last pre-switch gate re-measures the candidate and production boundary.
// These are behavioural orchestration tests: each real database-facing child is
// replaced by an executable Node fixture, while the coordinator, arguments,
// ordering, fail-closed exits and secret boundary are exercised as shipped.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GATE = path.join(ROOT, "scripts", "check-pre-switch-release.mjs");
const DEPLOY = path.join(ROOT, "scripts", "deploy-immutable.sh");
const REQUIRED = "20260817000000,20260817100000";
const DEFERRED = "20260818000000";

const STUB = String.raw`import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const base = path.basename(process.argv[1]);
let logical = base;
if (base === "check-release-manifest.mjs") {
  logical = args.includes("--verify-claim") ? "claim" : "companions";
}
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ logical, args }) + "\n");
if (process.env.FAIL_TOOL === logical) {
  console.error("fixture refusal: " + logical);
  process.exit(9);
}
if (logical === "claim") {
  console.log("required_for_app=" + (process.env.DERIVED_REQUIRED ?? ""));
  console.log("deferred_contract=" + (process.env.DERIVED_DEFERRED ?? ""));
  console.log("release claim fixture OK");
} else if (base === "check-release-phase.mjs") {
  console.log("NEWME_DB_PHASE=compat");
} else {
  console.log(logical + " fixture OK");
}
`;

function fixture() {
  const work = mkdtempSync(path.join(tmpdir(), "newme-pre-switch-"));
  const release = path.join(work, "release");
  const scripts = path.join(release, "scripts");
  const modules = path.join(release, "node_modules");
  const migrations = path.join(release, "supabase", "migrations");
  const infra = path.join(release, "infra", "release");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(modules, { recursive: true });
  mkdirSync(migrations, { recursive: true });
  mkdirSync(infra, { recursive: true });
  for (const name of [
    "check-release-manifest.mjs",
    "verify-remote-migration-history.mjs",
    "db-phase-push.mjs",
    "check-release-phase.mjs",
  ]) {
    writeFileSync(path.join(scripts, name), STUB);
  }
  writeFileSync(path.join(release, "supabase", "migration-history-reconciliation.json"), "{}\n");
  writeFileSync(path.join(infra, "release-manifest.json"), "{}\n");
  const urlFile = path.join(work, "migration-db.url");
  const databaseUrl = ["postgres://fixture-user", "x".repeat(16)].join(":") + "@example.invalid/db";
  writeFileSync(urlFile, `${databaseUrl}\n`);
  const callLog = path.join(work, "calls.jsonl");
  writeFileSync(callLog, "");
  return { work, release, modules, urlFile, callLog };
}

function invoke(fx, {
  status = "applied_verified",
  ids = REQUIRED,
  expectedRequired = REQUIRED,
  expectedDeferred = DEFERRED,
  derivedRequired = REQUIRED,
  derivedDeferred = DEFERRED,
  failTool = "",
} = {}) {
  return spawnSync(
    process.execPath,
    [
      GATE,
      "--release-dir", fx.release,
      "--status", status,
      "--ids", ids,
      "--expect-required", expectedRequired,
      "--expect-deferred", expectedDeferred,
      "--url-file", fx.urlFile,
      "--modules-dir", fx.modules,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CALL_LOG: fx.callLog,
        DERIVED_REQUIRED: derivedRequired,
        DERIVED_DEFERRED: derivedDeferred,
        FAIL_TOOL: failTool,
      },
    },
  );
}

function calls(fx) {
  return readFileSync(fx.callLog, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("the coordinator binds exact derived sets to history, posture, companions and phase", () => {
  const fx = fixture();
  try {
    const result = invoke(fx);
    assert.equal(result.status, 0, result.stderr);
    const observed = calls(fx);
    assert.deepEqual(observed.map((call) => call.logical), [
      "claim",
      "verify-remote-migration-history.mjs",
      "db-phase-push.mjs",
      "companions",
      "check-release-phase.mjs",
    ]);

    const history = observed[1].args;
    assert.equal(history[history.indexOf("--require-applied") + 1], REQUIRED);
    assert.equal(history[history.indexOf("--require-unapplied") + 1], DEFERRED);
    assert.ok(history.includes("--release-manifest"));
    assert.ok(history.includes("--history-fixture"));
    assert.deepEqual(observed[2].args.slice(-2), [fx.modules, "--verify-only"]);
    assert.deepEqual(observed[3].args, ["--verify-companions"]);
    assert.ok(observed[4].args.includes("--for-switch"));
    assert.match(result.stdout, /history=verified posture=verified companions=verified phase=verified/);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-user|x{16}/);
  } finally {
    rmSync(fx.work, { recursive: true, force: true });
  }
});
test("a changed derived set is refused before any database or companion verdict", () => {
  const fx = fixture();
  try {
    const result = invoke(fx, { derivedRequired: "20260817000000" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /required\/deferred sets changed after the early release gate/);
    assert.deepEqual(calls(fx).map((call) => call.logical), ["claim"]);
  } finally {
    rmSync(fx.work, { recursive: true, force: true });
  }
});

test("each negative history, posture, companion or phase verdict stops the switch gate", async (t) => {
  const order = [
    "claim",
    "verify-remote-migration-history.mjs",
    "db-phase-push.mjs",
    "companions",
    "check-release-phase.mjs",
  ];
  for (const failTool of order.slice(1)) {
    await t.test(failTool, () => {
      const fx = fixture();
      try {
        const result = invoke(fx, { failTool });
        assert.equal(result.status, 1, `${failTool} unexpectedly passed`);
        assert.match(result.stderr, /refused the pre-switch state/);
        assert.deepEqual(calls(fx).map((call) => call.logical), order.slice(0, order.indexOf(failTool) + 1));
      } finally {
        rmSync(fx.work, { recursive: true, force: true });
      }
    });
  }
});

test("not_required re-measures the whole release as no-pending", () => {
  const fx = fixture();
  try {
    const result = invoke(fx, {
      status: "not_required",
      ids: "",
      expectedRequired: "",
      expectedDeferred: "",
      derivedRequired: "",
      derivedDeferred: "",
    });
    assert.equal(result.status, 0, result.stderr);
    const history = calls(fx)[1].args;
    assert.ok(history.includes("--require-no-pending"));
    assert.ok(!history.includes("--require-applied"));
    assert.ok(!history.includes("--require-unapplied"));
  } finally {
    rmSync(fx.work, { recursive: true, force: true });
  }
});

test("deploy-immutable invokes the coordinator as the last fallible switch precondition", () => {
  const source = readFileSync(DEPLOY, "utf8").replaceAll("\r\n", "\n");
  const gate = source.indexOf('PRE_SWITCH_OUTPUT="$(node "$PRE_SWITCH_GATE"');
  const ciFreshness = source.indexOf('node "$RELEASE/scripts/check-deploy-ci-binding.mjs"', gate);
  const canonicalMain = source.indexOf("verify_canonical_main", ciFreshness);
  const pending = source.indexOf("write_deploy_state switch_pending", gate);
  const traffic = source.indexOf('mv -Tf "$CURRENT_NEXT" "$CURRENT"', pending);
  assert.ok(gate > 0 && gate < ciFreshness && ciFreshness < canonicalMain && canonicalMain < pending && pending < traffic);
  const invocation = source.slice(gate, pending);
  for (const argument of [
    '--release-dir "$RELEASE"',
    '--status "$MIGRATION_STATUS"',
    '--ids "${MIGRATION_IDS:-}"',
    '--expect-required "$INITIAL_REQUIRED_IDS"',
    '--expect-deferred "$INITIAL_DEFERRED_IDS"',
    '--url-file "$MIGRATION_DB_URL_FILE"',
    '--modules-dir "$RELEASE/node_modules"',
  ]) {
    assert.ok(invocation.includes(argument), `pre-switch invocation omits ${argument}`);
  }
  assert.match(source, /INITIAL_REQUIRED_IDS=.*required_for_app/);
  assert.match(source, /INITIAL_DEFERRED_IDS=.*deferred_contract/);
  assert.match(source, /exact pre-switch migration history\/posture\/companion revalidation refused/);
  assert.doesNotMatch(invocation, /--url[= ]postgres/);
});
