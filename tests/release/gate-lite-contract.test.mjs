/**
 * Gate-lite (2026-11-20): the one-command release lane `newme-deploy lite`.
 *
 * What the lane must keep (and these tests hold it to): the exact canonical-main
 * SHA, a green release-candidate run on that SHA, the migration-history and
 * posture gates, the control-plane asset transaction and the post-switch
 * health / smoke / log gates with automatic rollback. What it changes: the run id,
 * migration set and rollback SHA are derived; host-load settle, the observability
 * composite probe and data-quality regression findings are warnings (the
 * taskboard scope still blocks); the evidence is complete when the command returns.
 *
 * The health probe is executed, not grepped: a bounded retry that still fails
 * closed is the difference between "load-aware" and "ignores health".
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WRAPPER = fs.readFileSync(path.join(REPO, "infra/systemd/newme-deploy.sh"), "utf8").replaceAll("\r\n", "\n");
const IMMUTABLE = fs.readFileSync(path.join(REPO, "scripts/deploy-immutable.sh"), "utf8").replaceAll("\r\n", "\n");
const CI = fs.readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8").replaceAll("\r\n", "\n");

/** Lift a `name() {` ... `}` function (closing brace at column 0) out of a shell file. */
function extractFunction(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${name}() {`);
  assert.notEqual(start, -1, `${name}() is not defined`);
  const end = lines.indexOf("}", start);
  assert.notEqual(end, -1, `${name}() has no closing brace at column 0`);
  return lines.slice(start, end + 1).join("\n");
}

test("the wrapper routes `lite` as a coordinator mode next to bootstrap and db-transition", () => {
  const router = /BOOTSTRAP_ONLY=0\nDB_TRANSITION_ONLY=0\nDB_TRANSITION_OPERATION=""\ncase "\$\{1:-\}" in\n([\s\S]*?)\nesac\n([\s\S]*?)\nSHA=\$\{1:-\}/.exec(WRAPPER);
  assert.ok(router, "the mode router is not followed by the lite lane defaults");
  assert.match(router[1], /lite\)\n\s*LITE_LANE=1\n\s*shift\n\s*;;/);
  assert.match(router[2], /^LITE_PRE_WARNINGS=\(\)$/m);
  // The lane defaults to off before the router runs, so no inherited environment can switch it on.
  assert.ok(WRAPPER.indexOf("\nLITE_LANE=0\n") > 0 && WRAPPER.indexOf("\nLITE_LANE=0\n") < WRAPPER.indexOf("BOOTSTRAP_ONLY=0\n"));
  assert.equal((WRAPPER.match(/^LITE_LANE=1$/gm) ?? []).length, 0);
  assert.equal((WRAPPER.match(/^\s*LITE_LANE=1$/gm) ?? []).length, 1);
  assert.match(WRAPPER, /usage: newme-deploy lite <main-sha> \[successful-run-id\] \[not_required\|applied_verified\|reentry_verified\|contract_verified\]/);
});

test("the lite lane derives what the full lane makes the operator type, and verifies it the same way", () => {
  // Run id: resolved from GitHub for the exact SHA, dispatch event, main, success — then checked like a typed one.
  assert.match(WRAPPER, /actions\/workflows\/\$CANONICAL_CI_WORKFLOW_ID\/runs\?head_sha=\$SHA&event=workflow_dispatch&status=success/);
  const resolve = WRAPPER.indexOf('if [ -z "$RUN_ID" ]; then');
  const verify = WRAPPER.indexOf('RUN_JSON="$(curl');
  assert.ok(resolve > 0 && verify > resolve, "the run id must be resolved before the run is verified");
  assert.match(WRAPPER.slice(resolve, verify), /\[\[ "\$RUN_ID" =~ \^\[0-9\]\+\$ \]\] \|\| exit 64/);
  // Rollback SHA: the live release, exactly as the database-transition mode derives it.
  assert.match(WRAPPER, /if \[ "\$DB_TRANSITION_ONLY" -eq 1 \] \|\| \[ "\$LITE_LANE" -eq 1 \]; then\n\s*case "\$LIVE_RELEASE" in \/opt\/newme\/releases\//);
  // Migration ids: listed from the release manifest, then still held to --verify-claim.
  const derive = WRAPPER.indexOf("check-release-manifest.mjs --phase required_for_app --list");
  const claim = WRAPPER.indexOf("--verify-claim --status \"$MIGRATION_STATUS\" --ids \"$MIGRATION_IDS\"");
  assert.ok(derive > 0 && claim > derive, "the derived set must pass through the same claim judgement");
});

test("the lite lane is handed to deploy-immutable explicitly and skips only the browser-acceptance runtime", () => {
  assert.match(WRAPPER, /NEWME_RELEASE_LANE="\$\(\[ "\$LITE_LANE" -eq 1 \] && echo lite \|\| echo legacy\)" \\\n/);
  assert.match(WRAPPER, /NEWME_LITE_PRE_WARNINGS=/);
  assert.match(WRAPPER, /if \[ "\$LITE_LANE" -eq 1 \]; then\n\s*echo "lite lane: browser acceptance is not part of this lane[^\n]*"\nelse\n\s*prepare_postdeploy_browser_image \|\| \{/);
  // Every gate before the record is unconditional in both lanes.
  for (const gate of [
    'require_canonical_main_sha "$SHA"',
    "verify-remote-migration-history.mjs",
    "check-release-manifest.mjs --verify-companions",
    'bash "$WORKTREE/scripts/install-systemd-assets.sh"',
  ]) {
    assert.ok(WRAPPER.includes(gate), `${gate} is missing`);
  }
  assert.doesNotMatch(WRAPPER, /LITE_LANE" -eq 1 \] \|\| "\$NODE_BIN" "\$WORKTREE\/scripts\/verify-remote-migration-history/);
  // AGENTS.md: an unfinished board aborts the deploy, in the lite lane too. The check stays
  // unconditional and the gate record always claims it (review of #579).
  assert.match(WRAPPER, /"\$NODE_BIN" "\$WORKTREE\/scripts\/check-taskboard\.mjs" --require-scope=predeploy_ready \|\| \{\n\s*echo "TASKBOARD\.md at canonical main is not predeploy-ready; production operation is blocked" >&2\n\s*return 65\n\s*\}/);
  assert.doesNotMatch(WRAPPER, /TASKBOARD_GATE|OPTIONAL_GATES/);
  assert.match(WRAPPER, /gate=github-required-jobs-green\ngate=taskboard-predeploy-ready\ngate=release-claim-derived/);
});

test("deploy-immutable: the post-switch health probe retries while the host is busy and still fails closed", () => {
  const fn = extractFunction(IMMUTABLE, "probe_health_until_ready");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newme-health-probe-"));
  const counter = path.join(dir, "calls");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // A curl that fails until the Nth call: the host is "busy" for a while.
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash\nn=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${counter}"\n[ "$n" -ge "\${FAIL_UNTIL:-1}" ]\n`,
  );
  fs.chmodSync(path.join(bin, "curl"), 0o755);
  const run = (failUntil, attempts) => {
    fs.rmSync(counter, { force: true });
    const script = path.join(dir, "run.sh");
    fs.writeFileSync(script, `set -u\n${fn}\nprobe_health_until_ready http://127.0.0.1:3001/api/health\n`);
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAIL_UNTIL: String(failUntil),
        HEALTH_PROBE_ATTEMPTS: String(attempts),
        HEALTH_PROBE_INTERVAL_SECONDS: "1",
        HEALTH_PROBE_TIMEOUT_SECONDS: "1",
      },
    });
    return { ...result, calls: Number(fs.readFileSync(counter, "utf8")) };
  };
  const recovered = run(3, 5);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.calls, 3, "the probe must stop at the first healthy answer");
  assert.match(recovered.stdout, /post-switch health OK \(attempt 3\/5/);
  assert.match(recovered.stderr, /not ready \(attempt 1\/5/);

  const dead = run(99, 3);
  assert.equal(dead.status, 1, "a release that never answers must still fail");
  assert.equal(dead.calls, 3, "the retry window is bounded");

  // And the deploy path uses it where the single probe used to be, on the failure path that rolls back.
  assert.match(IMMUTABLE, /probe_health_until_ready http:\/\/127\.0\.0\.1:3001\/api\/health \|\| \{ fail "post-switch health failed after \$HEALTH_PROBE_ATTEMPTS probes"; exit 1; \}/);
  assert.doesNotMatch(IMMUTABLE, /curl -fsS --max-time 10 http:\/\/127\.0\.0\.1:3001\/api\/health >\/dev\/null \|\| \{ fail "post-switch health failed"; exit 1; \}/);
  // The rollback paths verify the restored release with the same bounded retry, so a
  // busy host cannot strand a completed rollback as app_rollback_pending.
  for (const name of ["rollback_release", "rollback_assets"]) {
    const body = extractFunction(IMMUTABLE, name);
    assert.match(body, /probe_health_until_ready http:\/\/127\.0\.0\.1:3001\/api\/health \|\| return 1/, name);
    assert.doesNotMatch(body, /curl -fsS --max-time 10/, name);
  }
});

test("deploy-immutable: the lane is validated, and only the lite lane downgrades load, the composite probe and data quality to warnings", () => {
  assert.match(IMMUTABLE, /RELEASE_LANE="\$\{NEWME_RELEASE_LANE:-legacy\}"\ncase "\$RELEASE_LANE" in legacy\|lite\) ;; \*\) [^\n]*exit 64 ;; esac/);
  const bad = spawnSync("bash", [path.join(REPO, "scripts/deploy-immutable.sh"), "a".repeat(40)], {
    encoding: "utf8",
    env: { ...process.env, NEWME_RELEASE_LANE: "yolo" },
  });
  // Non-root exits 77 first on a real host; as root the lane check must exit 64. Either way "yolo" never deploys.
  assert.ok([64, 77].includes(bad.status), `unexpected exit ${bad.status}: ${bad.stderr}`);

  assert.match(IMMUTABLE, /HOST_LOAD_SETTLE_TIMEOUT_SECONDS="\$\(\[ "\$RELEASE_LANE" = lite \] && echo 600 \|\| echo 120\)"/);
  assert.match(IMMUTABLE, /\[ "\$RELEASE_LANE" = lite \] \|\| \{ fail "host load did not settle before the release switch"; exit 1; \}/);
  assert.match(IMMUTABLE, /bash \/opt\/hermes-scripts\/observability\/l0-composite-probe\.sh \|\| lite_warn/);
  assert.match(IMMUTABLE, /else\n\s*bash \/opt\/hermes-scripts\/observability\/l0-composite-probe\.sh\nfi/);
  assert.match(IMMUTABLE, /CRM_REGRESSION_DATA_QUALITY="\$\(\[ "\$RELEASE_LANE" = lite \] && echo warn \|\| echo block\)"/);
  // Smoke, journald scan and the service-identity check are lane-independent.
  assert.match(IMMUTABLE, /^bash "\$TARGET\/scripts\/check-smoke\.sh" http:\/\/127\.0\.0\.1:3001$/m);
  assert.match(IMMUTABLE, /^NEWME_INVOCATION_ID="\$INVOCATION_ID" bash "\$TARGET\/scripts\/check-logs\.sh" "2 minutes ago"$/m);
});

test("deploy-immutable: lite evidence is complete with its warnings; legacy evidence is unchanged", () => {
  assert.match(IMMUTABLE, /if release_lane == "lite":\n(?:\s*#[^\n]*\n)*\s*evidence\["release_status"\] = "complete"/);
  assert.match(IMMUTABLE, /"release_lane": release_lane,/);
  assert.match(IMMUTABLE, /"lite": \{"warnings": lite_warnings\} if release_lane == "lite" else None,/);
  assert.match(IMMUTABLE, /status=complete lane=lite warnings=\$\{#LITE_WARNINGS\[@\]\}/);
  assert.match(IMMUTABLE, /status=awaiting_uat"\nfi/);
});

test("crm-regression: data-quality findings warn only when asked, connectivity findings always block", () => {
  const selfTest = spawnSync("python3", [path.join(REPO, "scripts/crm-regression.py"), "--self-test"], { encoding: "utf8" });
  assert.equal(selfTest.status, 0, selfTest.stderr);
  const probe = spawnSync(
    "python3",
    [
      "-c",
      [
        "import importlib.util, sys",
        `spec = importlib.util.spec_from_file_location('crm', ${JSON.stringify(path.join(REPO, "scripts/crm-regression.py"))})`,
        "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
        "blocking = {'健康检查 API 200', '登录页 200', 'leads 表可访问', 'profiles 表可访问', 'service key is registered', 'Supabase public API connectivity'}",
        "assert not (blocking & m.DATA_QUALITY_CHECKS), blocking & m.DATA_QUALITY_CHECKS",
        "assert m.is_data_quality_check('无空名称线索')",
        "print('ok')",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), "ok");
});

test("ci: a release-candidate dispatch on main is never cancelled by a merge landing on main", () => {
  assert.match(CI, /group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'workflow_dispatch' && github\.run_id \|\| github\.ref \}\}/);
  assert.match(CI, /cancel-in-progress: \$\{\{ github\.event_name != 'workflow_dispatch' \}\}/);
});

test("the lite lane reports its warnings to the operations alert channel without making the release depend on it", () => {
  const tail = WRAPPER.slice(WRAPPER.indexOf("DEPLOY_SUCCEEDED=1\n\nif [ \"$LITE_LANE\" -eq 1 ]; then"));
  assert.ok(tail.length > 0, "the lite completion block is missing");
  assert.match(tail, /\/usr\/local\/libexec\/newme\/newme-whatsapp-alert\.sh release-lite info "\$LITE_SUMMARY" \|\|/);
  assert.match(tail, /NEWME_RELEASE_LANE=lite/);
  assert.doesNotMatch(tail, /newme-whatsapp-alert\.sh[^\n]*\n[^\n]*exit 65/);
});
