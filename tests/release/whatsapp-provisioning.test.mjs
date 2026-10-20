import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { judgeProvisioning, OBSERVER } from "../../scripts/check-whatsapp-provisioning.mjs";

const bash = process.env.NEWME_TEST_BASH || (process.platform === "win32" &&
  fs.existsSync("C:/Program Files/Git/bin/bash.exe") ? "C:/Program Files/Git/bin/bash.exe" : "bash");
const sql = fs.readFileSync(new URL("../fixtures/whatsapp-pilot-events.sql.txt", import.meta.url), "utf8");
const old = { version: "20260818000000", file: "20260818000000_money_direct_write_contract_phase.sql", sha256: "a".repeat(64) };
function input() {
  const live = { runs_under: { database_phases: ["compat", "strict"] },
    required_for_app: [{ version: "20260806000000", file: "20260806000000_expand.sql", sha256: "b".repeat(64) }],
    deferred_contract: [old] };
  const candidate = structuredClone(live);
  candidate.deferred_contract.push({ version: OBSERVER.version, file: OBSERVER.file, sha256: OBSERVER.sha256 });
  return { live, candidate, sql, phase: "strict", existingTables: [], recordedVersions: [] };
}
const rejects = (state, pattern) => assert.match(judgeProvisioning(state).problems.join("; "), pattern);

test("permits only the reviewed additive observer after the unchanged strict prefix", () => {
  assert.deepEqual(judgeProvisioning(input()), { problems: [], version: OBSERVER.version, alreadyRecorded: false });
});
test("idempotent recovery requires both tables and the recorded observer version", () => {
  const s = input(); s.existingTables = [...OBSERVER.tables]; s.recordedVersions = [OBSERVER.version];
  assert.deepEqual(judgeProvisioning(s).problems, []);
  s.existingTables.pop(); rejects(s, /presence.*recorded/);
});
for (const phase of ["compat", "absent", "unreadable", undefined]) {
  test(`refuses ${String(phase)} mode`, () => rejects({ ...input(), phase }, /already be strict/));
}
for (const side of ["live", "candidate"]) {
  test(`refuses missing strict declaration on ${side}`, () => {
    const s = input(); s[side].runs_under.database_phases = ["compat"]; rejects(s, /strict compatibility/);
  });
}
for (const key of ["version", "file", "sha256"]) {
  test(`refuses changed existing required ${key}`, () => {
    const s = input(); s.candidate.required_for_app[0][key] += "x"; rejects(s, /required migration/);
  });
  test(`refuses changed existing deferred ${key}`, () => {
    const s = input(); s.candidate.deferred_contract[0][key] += "x"; rejects(s, /preserve.*prefix/);
  });
  test(`refuses an unreviewed observer ${key}`, () => {
    const s = input(); s.candidate.deferred_contract.at(-1)[key] += "x"; rejects(s, /reviewed observer/);
  });
}
test("refuses a missing required list or missing deferred prefix", () => {
  const a = input(); delete a.candidate.required_for_app; rejects(a, /required migration/);
  const b = input(); b.live.deferred_contract = []; rejects(b, /preserve.*prefix/);
});
test("refuses an extra deferred migration, even with an otherwise approved observer", () => {
  const s = input(); s.candidate.deferred_contract.splice(1, 0, { ...old, version: "20260901000000" });
  rejects(s, /exactly one/);
});
test("refuses SQL content changes even when its manifest claims the approved hash", () => {
  rejects({ ...input(), sql: sql + "\ngrant select on public.profiles to anon;\n" }, /immutable hash/);
});
test("normalises CRLF without changing the SQL reviewed by the gate", () => {
  assert.deepEqual(judgeProvisioning({ ...input(), sql: sql.replaceAll("\n", "\r\n") }).problems, []);
});
for (const table of OBSERVER.tables) {
  test(`refuses pre-existing unrecorded table ${table}`, () => {
    rejects({ ...input(), existingTables: [table] }, /presence.*recorded/);
  });
}
test("refuses a recorded migration whose two tables are absent", () => {
  rejects({ ...input(), recordedVersions: [OBSERVER.version] }, /presence.*recorded/);
});
test("does not admit applying the observer twice in the manifest", () => {
  const s = input(); s.live = structuredClone(s.candidate); s.candidate.deferred_contract.push({ ...s.candidate.deferred_contract.at(-1) });
  rejects(s, /reviewed observer/);
});

// Execute the coordinator's actual branch, with only its external dependencies
// replaced. A failed antecedent must stop before the existing phase applier.
const wrapper = fs.readFileSync(new URL("../../infra/systemd/newme-deploy.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const start = wrapper.indexOf("  # A completed strict release cannot deploy");
assert.notEqual(start, -1);
const end = wrapper.indexOf('  case "$DB_TRANSITION_OPERATION" in', start);
const preconditions = wrapper.slice(start, end);
const arm = wrapper.match(/    whatsapp-plan\|whatsapp-provision\)\n([\s\S]*?)      ;;/)?.[1];
assert.ok(arm);
function coordinator(operation, fail = "none") {
  const script = `set -Eeuo pipefail
DB_TRANSITION_OPERATION=${operation}
FAIL_STAGE=${fail}
MIRROR=/approved/mirror
ROLLBACK_SHA=live
SHA=candidate
LIVE_RELEASE=/approved/live
WORKTREE=/approved/candidate
MIGRATION_DB_URL_FILE=/approved/protected-url-file
NODE_BIN=mock_node
git() { printf 'ancestry\\n'; [ "$FAIL_STAGE" != ancestry ]; }
mock_node() {
  if [ "$1" = /approved/live/scripts/db-phase-push.mjs ]; then
    printf 'live-posture\\n'; [ "$FAIL_STAGE" != live-posture ]
  elif [ "$1" = /approved/candidate/scripts/check-whatsapp-provisioning.mjs ]; then
    printf 'observer-policy\\n'; [ "$FAIL_STAGE" != observer-policy ]
  elif [ "$1" = /approved/candidate/scripts/db-phase-push.mjs ]; then
    printf 'APPLIER:%s\\n' "$*"
  else return 89
  fi
}
require_canonical_main_sha() { printf 'canonical-main\\n'; [ "$FAIL_STAGE" != canonical-main ]; }
require_ci_gate_still_fresh() { printf 'fresh-ci\\n'; [ "$FAIL_STAGE" != fresh-ci ]; }
${preconditions}
${arm}
`;
  return spawnSync(bash, ["-c", script], { encoding: "utf8" });
}
for (const [operation, mode] of [["whatsapp-plan", "--plan"], ["whatsapp-provision", "--apply"]]) {
  test(`${operation} runs the actual coordinator gates before ${mode}`, () => {
    const r = coordinator(operation);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ancestry\nlive-posture\nobserver-policy\ncanonical-main\nfresh-ci\nAPPLIER:/);
    assert.ok(r.stdout.includes(`--phase deferred_contract ${mode}`));
  });
  for (const fail of ["ancestry", "live-posture", "observer-policy", "canonical-main", "fresh-ci"]) {
    test(`${operation} refuses before any applier when ${fail} fails`, () => {
      const r = coordinator(operation, fail);
      assert.notEqual(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /APPLIER:/);
    });
  }
}
