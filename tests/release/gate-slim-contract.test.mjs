// Contract for the gate-slimming change: what was relaxed (the alert drill, as a recorded warning) and, as importantly,
// what was not. These are source-level assertions plus one real `patch --dry-run` of the documented coordinator diff.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

test("only alert refusals are downgradable; fixtures, health and rollback stay on the freezing path", () => {
  const runner = read("scripts/run-postdeploy-acceptance.mjs");
  assert.match(runner, /const WARNABLE_ALERT_CODE = \/\^\(\?:alert\|delayed_alert\)_\[a-z0-9_\]\{1,50\}\$\/;/);
  // the only two catch sites that may call recordAlertWarning are guarded by the classifier
  assert.equal([...runner.matchAll(/isWarnableAlertFailure\(error, signal\)\) throw error;/g)].length, 2);
  assert.equal([...runner.matchAll(/recordAlertWarning\(\{/g)].length, 3); // definition plus the two guarded call sites
  // the outer failure handler that writes uat_failed is untouched
  assert.match(runner, /recordJournalFailure\(journal, errorCode\(error\), cleanup, null\);\n    throw error;/);
  // the freeze for in-flight journals is still present
  assert.match(runner, /refuse\("uat_recovery_required"\)/);
  assert.match(runner, /refuse\("journal_recovery_required"\)/);
  // service, logs and restarts keep their pass-only outcome
  assert.match(runner, /status: id === "alerts" && !providerReadback \? "warned" : "pass"/);
  assert.match(runner, /refuse\("delayed_critical_logs_present"\)/);
  assert.match(runner, /refuse\("delayed_service_probe_failed"\)/);
});

test("the policy and schema expose the warning explicitly and keep the pass contract", () => {
  const policy = JSON.parse(read("infra/release/postdeploy-acceptance-policy-v1.json"));
  assert.equal(policy.alert_drill.final_status, "ok");
  assert.equal(policy.alert_drill.allow_recorded_warning, true);
  assert.equal(policy.alert_drill.warning_final_status, "warned");
  assert.deepEqual(policy.delayed_verification.required_checks, ["service", "logs", "alerts", "restarts"]);
  assert.equal(policy.artifacts.minimum_count, 16);
  const schema = JSON.parse(read("infra/release/postdeploy-evidence-v1.schema.json"));
  assert.equal(schema.properties.alert_drill.oneOf.length, 2);
  assert.equal(schema.properties.delayed_verification.oneOf.length, 2);
  assert.deepEqual(schema.$defs.delayedCheck.properties.status.enum, ["pass", "warned"]);
  assert.equal(schema.$defs.passingCheck.properties.status.const, "pass");
});

test("the alert provider tolerates two seconds of whole-second timestamp skew and no more", () => {
  const provider = read("infra/observability/newme-alert-provider-v1.mjs");
  assert.match(provider, /Date\.parse\(occurredAt\) \+ 2000 < Date\.parse\(trigger\.triggered_at\)/);
  assert.match(provider, /Date\.parse\(occurredAt\) > Date\.now\(\) \+ 5000/);
});

test("the one-command close keeps every closing gate and adds no bypass", () => {
  const script = read("scripts/release-close.sh");
  assert.equal(spawnSync("bash", ["-n", path.join(ROOT, "scripts/release-close.sh")]).status, 0);
  for (const required of [
    "infra/release/branch-protection.json",
    "required check",
    "TASKBOARD.md",
    "--require-scope=predeploy_ready",
    "release_final=true",
    "-f closure_sha=\"$C\"",
    "git rev-list --count \"$SHA..$C\"",
    "finalize \"$SHA\" \"$DIG\" \"$C\" \"$RUN\"",
    "hashlib.sha256(raw).hexdigest() != sys.argv[2]",
  ]) assert.ok(script.includes(required), `missing ${required}`);
  for (const forbidden of [/--admin/, /--no-verify/, /--force-with-lease=/, /gh pr merge[^\n]*--auto/, /sleep 150/, /--no-checks/]) {
    assert.doesNotMatch(script, forbidden);
  }
  assert.match(script, /gh pr checks "\$N" --repo "\$REPO" --watch/);
  assert.match(script, /gh run watch "\$RUN"/);
});

test("the documented coordinator diff applies to the repository copy and is informational only", (t) => {
  const doc = read("docs/gate-slim-install.md");
  const diff = /```diff\n([\s\S]*?)\n```/.exec(doc)?.[1];
  assert.ok(diff, "the install note must carry the unified diff");
  const added = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  assert.ok(added.length > 0);
  assert.equal(diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length, 0, "the diff may only add lines");
  const probe = spawnSync("patch", ["--version"]);
  if (probe.error) { t.skip("patch is not installed"); return; }
  const applied = spawnSync("patch", ["--dry-run", "-o", "/dev/null", path.join(ROOT, "infra/systemd/newme-deploy.sh")], { input: `${diff}\n`, encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.doesNotMatch(added.join("\n"), /exit [1-9]|rm |systemctl|chmod|sudo/);
});
