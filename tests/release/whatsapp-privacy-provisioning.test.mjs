import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { judgePrivacyProvisioning, PRIVACY } from "../../scripts/check-whatsapp-privacy-provisioning.mjs";
import { OBSERVER } from "../../scripts/check-whatsapp-provisioning.mjs";

const bash = process.env.NEWME_TEST_BASH || (process.platform === "win32" && fs.existsSync("C:/Program Files/Git/bin/bash.exe") ? "C:/Program Files/Git/bin/bash.exe" : "bash");
const sql = fs.readFileSync(new URL("../fixtures/whatsapp-privacy-lifecycle.sql.txt", import.meta.url), "utf8");
const entry = ({ version, file, sha256 }) => ({ version, file, sha256 });
function input() {
  const live = { runs_under: { database_phases: ["compat", "strict"] },
    required_for_app: [{ version: "20260806000000", file: "20260806000000_expand.sql", sha256: "a".repeat(64) }],
    deferred_contract: [{ version: "20260818000000", file: "20260818000000_contract.sql", sha256: "b".repeat(64) }, entry(OBSERVER)] };
  const candidate = structuredClone(live); candidate.deferred_contract.push(entry(PRIVACY));
  return { live, candidate, sql, phase: "strict", recordedVersions: [OBSERVER.version], existingObjects: [], ownershipMismatches: [], enabledChannels: 0 };
}
const refuses = (state, pattern) => assert.match(judgePrivacyProvisioning(state).problems.join("; "), pattern);
test("only the reviewed privacy suffix with disabled channels is accepted", () => {
  assert.deepEqual(judgePrivacyProvisioning(input()), { problems: [], version: PRIVACY.version, alreadyRecorded: false });
});
test("complete recorded state is accepted for interrupted provisioning recovery", () => {
  const s = input(); s.recordedVersions.push(PRIVACY.version); s.existingObjects = [...PRIVACY.objects];
  assert.deepEqual(judgePrivacyProvisioning(s).problems, []);
});
for (const phase of [undefined, "compat", "absent"]) test(`refuses ${phase} mode`, () => refuses({ ...input(), phase }, /already be strict/));
for (const enabledChannels of [undefined, 1, "0", -1]) test(`refuses unproved disabled-channel count ${enabledChannels}`, () => refuses({ ...input(), enabledChannels }, /disabled/));
for (const field of ["version", "file", "sha256"]) {
  test(`rejects changed required ${field}`, () => { const s = input(); s.candidate.required_for_app[0][field] += "x"; refuses(s, /required migration/); });
  test(`rejects changed prior ${field}`, () => { const s = input(); s.candidate.deferred_contract[0][field] += "x"; refuses(s, /entire deferred prefix/); });
  test(`rejects unknown suffix ${field}`, () => { const s = input(); s.candidate.deferred_contract.at(-1)[field] += "x"; refuses(s, /reviewed privacy/); });
}
test("missing observer, additional migration and edited SQL each refuse", () => {
  const a = input(); a.recordedVersions = []; refuses(a, /observer prerequisite/);
  const b = input(); b.candidate.deferred_contract.push(entry(PRIVACY)); refuses(b, /exactly one/);
  refuses({ ...input(), sql: sql + "\ngrant all on public.leads to anon;" }, /immutable hash/);
});
test("SQL hash normalizes Windows line endings", () => assert.deepEqual(judgePrivacyProvisioning({ ...input(), sql: sql.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n") }).problems, []));
test("missing ownership proof and unexpected object owners refuse", () => {
  refuses({ ...input(), ownershipMismatches: undefined }, /ownership/);
  refuses({ ...input(), ownershipMismatches: ["whatsapp_privacy.admit_event()"] }, /ownership/);
  assert.ok(PRIVACY.objects.includes("schema:whatsapp_privacy"));
  assert.ok(PRIVACY.objects.includes("whatsapp_privacy.admit_event()"));
  assert.ok(PRIVACY.objects.includes("trigger:whatsapp_privacy_admission"));
  assert.ok(sql.indexOf("lock table public.whatsapp_pilot_channels in share row exclusive mode") < sql.indexOf("create schema"));
  assert.match(sql, /raise exception 'whatsapp_channels_must_be_disabled'/);
});
for (const object of PRIVACY.objects) {
  test(`unrecorded collision or missing recorded ${object} refuses`, () => {
    refuses({ ...input(), existingObjects: [object] }, /presence.*recorded/);
    const s = input(); s.recordedVersions.push(PRIVACY.version); s.existingObjects = PRIVACY.objects.filter(o => o !== object);
    refuses(s, /presence.*recorded/);
  });
}

const wrapper = fs.readFileSync(new URL("../../infra/systemd/newme-deploy.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const begin = wrapper.indexOf("  # The privacy lifecycle has a different reviewed hash");
const end = wrapper.indexOf('  case "$DB_TRANSITION_OPERATION" in', begin);
assert.ok(begin > 0 && end > begin);
const preconditions = wrapper.slice(begin, end);
const arm = wrapper.match(/    whatsapp-privacy-plan\|whatsapp-privacy-provision\)\n([\s\S]*?)      ;;/)?.[1];
assert.ok(arm);
function coordinator(operation, failure = "none") {
  return spawnSync(bash, ["-c", `set -Eeuo pipefail
DB_TRANSITION_OPERATION=${operation}
FAIL_STAGE=${failure}
MIRROR=/approved/mirror
ROLLBACK_SHA=live
SHA=candidate
LIVE_RELEASE=/approved/live
WORKTREE=/approved/candidate
MIGRATION_DB_URL_FILE=/approved/private-url
NODE_BIN=mock_node
git() { printf 'ancestry\\n'; [ "$FAIL_STAGE" != ancestry ]; }
mock_node() {
  if [ "$1" = /approved/live/scripts/db-phase-push.mjs ]; then
    printf 'live-posture\\n'; [ "$FAIL_STAGE" != live-posture ]
  elif [ "$1" = /approved/candidate/scripts/check-whatsapp-privacy-provisioning.mjs ]; then
    printf 'privacy-policy\\n'; [ "$FAIL_STAGE" != privacy-policy ]
  elif [ "$1" = /approved/candidate/scripts/db-phase-push.mjs ]; then
    printf 'APPLIER:%s\\n' "$*"
  else return 89
  fi
}
require_canonical_main_sha() { printf 'canonical-main\\n'; [ "$FAIL_STAGE" != canonical-main ]; }
require_ci_gate_still_fresh() { printf 'fresh-ci\\n'; [ "$FAIL_STAGE" != fresh-ci ]; }
${preconditions}
${arm}
`], { encoding: "utf8" });
}
for (const [operation, mode] of [["whatsapp-privacy-plan", "--plan"], ["whatsapp-privacy-provision", "--apply"]]) {
  test(`${operation} executes all antecedents before ${mode}`, () => {
    const p = coordinator(operation); assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /ancestry\nlive-posture\nprivacy-policy\ncanonical-main\nfresh-ci\nAPPLIER:/);
    assert.ok(p.stdout.includes(`--phase deferred_contract ${mode}`));
  });
  for (const failure of ["ancestry", "live-posture", "privacy-policy", "canonical-main", "fresh-ci"]) {
    test(`${operation} refuses before the applier after ${failure} failure`, () => {
      const p = coordinator(operation, failure); assert.notEqual(p.status, 0); assert.doesNotMatch(p.stdout, /APPLIER:/);
    });
  }
}
