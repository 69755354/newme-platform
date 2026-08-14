// ============================================================================
// Contract test: the kpi_targets period-lock race is measured, in both directions
// ============================================================================
// R3. 20260817000000 §14 and 20260817150000 gave replace_kpi_targets() and
// clear_kpi_targets() a period-scoped advisory lock and described it as
// serializing "a save and a clear of one period". That was the whole gap:
// confirm_payment() and void_payment(), the two routines that move money into and
// out of kpi_targets.actual_amount, wrote the same period's rows and took no lock.
//
// supabase/replay/19_concurrency_kpi_period.sh is the reproduction, and this file
// is what keeps it a reproduction. A concurrency gate can rot in ways a passing
// run does not show: the control direction can be dropped so only the green half
// runs, the barrier can decay into a sleep, the verdict can shrink to "the lock
// is installed" — which is a source-text claim wearing a database's clothes. Each
// of those is checked here, without a database.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { sqlWithoutComments } from "./sql-text.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const REPLAY_DIR = path.join(ROOT, "supabase", "replay");
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), "utf8");

const gate = read("supabase", "replay", "19_concurrency_kpi_period.sh");
const runner = read("scripts", "replay-migrations.sh");

function modeBody(name) {
  const starts = {
    history: 'if [ "$MODE" = history ]; then',
    control: 'if [ "$MODE" = control ]; then',
    branch: 'echo "== two-session concurrency (allocate_payment) =="',
  };
  const from = runner.indexOf(starts[name]);
  assert.notEqual(from, -1, `could not find the ${name} mode block`);
  const ends = { history: starts.control, control: starts.branch, branch: null };
  const to = ends[name] ? runner.indexOf(ends[name], from) : runner.length;
  return runner.slice(from, to === -1 ? runner.length : to);
}

test("both directions run, the control first, and neither is optional", () => {
  const branch = modeBody("branch");
  assert.match(runner, /KPI_PERIOD_GATE="\$REPLAY_DIR\/19_concurrency_kpi_period\.sh"/);
  assert.match(branch, /EXPECT=lost bash "\$KPI_PERIOD_GATE"\s*\\\s*\n\s*\|\| fail /);
  assert.match(branch, /EXPECT=serialized bash "\$KPI_PERIOD_GATE"\s*\\\s*\n\s*\|\| fail /);
  assert.equal((runner.match(/bash "\$KPI_PERIOD_GATE"/g) ?? []).length, 2);
  // The control runs FIRST. It mutates the two money routines and restores them;
  // running it second would let a failed restore be discovered only by whatever
  // ran next, and running it at all after a green serialized result proves
  // nothing about the result that already happened.
  // Both gate variables are compared, not just the EXPECT= prefix: the flip and
  // setter gates use the same `EXPECT=serialized` word earlier in the same block.
  assert.ok(
    branch.indexOf('EXPECT=lost bash "$KPI_PERIOD_GATE"') <
      branch.indexOf('EXPECT=serialized bash "$KPI_PERIOD_GATE"'),
    "the lock-free control must run before the serialized claim",
  );
  assert.match(branch, /\[ -f "\$KPI_PERIOD_GATE" \] \|\| fail /, "a missing gate must fail, not skip");
});

test("the un-remediated floor does not silently stand in for the control", () => {
  // MODE=control replays the floor, where B7's carry-forward does not exist, so a
  // target save there zeroes actuals whether or not anything raced it. The runner
  // has to say why the mutation-based control is the honest one.
  assert.doesNotMatch(modeBody("control"), /KPI_PERIOD_GATE/);
  assert.doesNotMatch(modeBody("history"), /KPI_PERIOD_GATE/);
  assert.match(runner, /the un-remediated floor has no B7 carry-forward/);
});

test("the gate has no default verdict and accepts only the two measured states", () => {
  assert.match(gate, /: "\$\{EXPECT:\?[^}]*\}"/);
  assert.doesNotMatch(gate, /EXPECT:-/);
  assert.match(gate, /case "\$EXPECT" in\s*\n\s*serialized\|lost\) ;;/);
});

test("the two sessions overlap at database-observed barriers", () => {
  assert.match(gate, /pg_advisory_xact_lock\(\$MARK_HI, \$marker\)/);
  assert.match(gate, /locktype = 'advisory' and classid = \$MARK_HI and objid = \$marker and granted/);
  assert.match(gate, /where not l\.granted and s\.application_name = 'replay_kpi_money'/);
  // Reaching neither barrier must be a failure with both logs, not a fall-through
  // into a verdict the gate never staged.
  assert.match(gate, /barrier never reached — \$what/);
  assert.match(gate, /dump_sessions/);

  const sleeps = [...gate.matchAll(/^\s*sleep .*$/gm)].map((match) => match[0].trim());
  assert.deepEqual(sleeps, ["sleep 0.2"], "only barrier polling may sleep");
});

test("the waiting session's locktype is asserted, so the two mechanisms cannot be confused", () => {
  // Without this a `lost` run that happened to block on the advisory lock — i.e.
  // a mutation that did not take — would still be scored as a reproduction.
  const awaiting = gate.slice(gate.indexOf("await_money_blocked()"));
  assert.match(awaiting, /string_agg\(distinct l\.locktype/);
  assert.match(awaiting, /not on the period's advisory lock/, "serialized does not require an advisory wait");
  assert.match(awaiting, /the lock-free control is waiting on an advisory lock/, "lost does not refuse an advisory wait");
  assert.match(awaiting, /\*,transactionid,\*\|\*,tuple,\*\) ;;/, "lost does not require a row-lock wait");
});

test("the control's mutant is derived from the installed definitions, not written by hand", () => {
  assert.match(gate, /pg_get_functiondef\('public\.confirm_payment\(uuid, uuid\)'::regprocedure\)/);
  assert.match(gate, /pg_get_functiondef\('public\.void_payment\(uuid, text\)'::regprocedure\)/);
  assert.match(gate, /LOCK_LINE="pg_advisory_xact_lock\(hashtextextended\('public\.kpi_targets:'"/);
  assert.match(gate, /grep -v -F "\$LOCK_LINE"/);
  // Exactly one line, or the mutation is not the one the gate claims to make.
  assert.match(gate, /\[ "\$\(\(before - after\)\)" = "1" \]/);
  // And the serialized direction refuses to run against a database where the lock
  // is not installed, so a green result cannot come from a missing migration.
  assert.match(gate, /would be asserting something that is not installed/);
  // The mutation is undone and the undo is verified byte-for-byte, from the EXIT
  // trap as well as from the happy path.
  assert.match(gate, /trap cleanup EXIT/);
  assert.match(gate, /restore_routines \|\| status=1/);
  assert.match(gate, /is not byte-identical to the definition captured on entry/);
  assert.match(gate, /restore_routines \|\| fail /);
});

test("the verdict compares actual_amount with the ledger, not the source text", () => {
  const verdict = gate.slice(gate.indexOf('case "$EXPECT" in', gate.indexOf("The verdict")));
  assert.match(verdict, /\[ "\$kpi_1" = "\$ledger_1" \] \|\| fail/);
  assert.match(verdict, /\[ "\$kpi_2" = "\$ledger_2" \] \|\| fail/);
  // The control has to lose something, and lose exactly what the migration header
  // says it loses. "Not equal" alone would also be satisfied by a broken fixture.
  assert.match(verdict, /\[ "\$kpi_1" = "0\.00" \]/);
  assert.match(verdict, /\[ "\$kpi_2" = "\$AMOUNT" \]/);
  assert.match(verdict, /did NOT lose anything/);
  // The ledger is derived from the payments themselves, so the comparison is
  // against the money and not against a second copy of the same number.
  assert.match(gate, /ledger_of\(\) \{\s*\n\s*q "select coalesce\(sum\(p\.amount\), 0\.00\)/);
  assert.match(gate, /and p\.confirmed = true\s*\n\s*and p\.voided_at is null"/);
  // Both operations must have reported success in both directions: the finding is
  // "success, and the KPI is wrong", not "the write failed".
  assert.equal((gate.match(/grep -q '"success"'/g) ?? []).length, 2);
});

test("the gate stages both directions of the money and both are checked", () => {
  assert.match(gate, /public\.confirm_payment\('\$PAYMENT', '\$FINANCE'\)/);
  assert.match(gate, /public\.void_payment\('\$PAYMENT', 'replay 19: kpi period lock gate'\)/);
  // void_payment() resolves its actor from the session, so the money session has
  // to carry the claim shape GoTrue issues or the gate would measure a refusal.
  assert.match(gate, /set_config\('request\.jwt\.claims'/);
  assert.match(gate, /'role', 'authenticated'/);
  // Stage 2 starts from a normalised target so it measures the debit instead of
  // inheriting stage 1's verdict, and the normalisation itself is checked.
  assert.match(gate, /\[ "\$normalised" = "1" \]/);
});

test("the gate's footprint is its own two rows, and it proves it left nothing behind", () => {
  assert.match(gate, /delete from public\.payments where id = '\$PAYMENT';/);
  assert.match(gate, /delete from public\.kpi_targets where period = '\$PERIOD';/);
  assert.match(gate, /\[ "\$left" = "0" \]/);
  assert.match(gate, /this gate created a projects row for \$CONTRACT/);
  assert.match(gate, /not the \$FP_ON_ENTRY it arrived with/);
  assert.doesNotMatch(gate, /delete from public\.(contracts|profiles|installment_plans)\b/);
  assert.doesNotMatch(gate, /PGPASSWORD|password=|postgres:\/\//);
  // Cleanup runs before the verdict, so a failing gate still hands the rollback
  // assertions the state the fixtures created.
  assert.ok(
    gate.indexOf("teardown.sql") < gate.indexOf("The verdict"),
    "the fixtures are removed after the verdict, so a failure leaves them behind",
  );
});

test("the gate's period is one no fixture and no assertion uses", () => {
  // replace_kpi_targets() deletes every row in its period, so a gate that reused
  // a fixture period would delete fixture rows and its own verdict would be about
  // them. Derived rather than asserted in prose: no other executable statement in
  // the replay set or the migrations may name this period.
  const PERIOD = /^PERIOD='([0-9]{4}-[0-9]{2})'/m.exec(gate);
  assert.ok(PERIOD, "the gate no longer pins its period");
  const others = [];
  for (const dir of [REPLAY_DIR, path.join(ROOT, "supabase", "migrations")]) {
    for (const file of readdirSync(dir)) {
      if (file === "19_concurrency_kpi_period.sh") continue;
      const text = readFileSync(path.join(dir, file), "utf8");
      const scanned = file.endsWith(".sql") ? sqlWithoutComments(text) : text;
      if (scanned.includes(PERIOD[1])) others.push(file);
    }
  }
  assert.deepEqual(others, [], `period ${PERIOD[1]} is used elsewhere, so this gate is not isolated`);
});

test("the comment stripper the isolation check runs on keeps every executable form", () => {
  // If it over-strips, the check above passes because it can no longer see a real
  // second writer of the gate's period. So the stripper is measured directly.
  const keeps = [
    "select '2019-11';",
    "$$ begin perform f('2019-11'); end $$;",
    "$do$ -- 2019-11 in a body is still executable text\n$do$;",
    "select 'it -- is not a comment 2019-11';",
    "select e'a''b 2019-11';",
  ];
  for (const sql of keeps) {
    assert.ok(sqlWithoutComments(sql).includes("2019-11"), sql);
  }
  const drops = [
    "-- 2019-11\nselect 1;",
    "select 1; -- period 2019-11 measured here",
    "/* 2019-11 */ select 1;",
    "select 1;\n/* multi\n 2019-11\n line */\n",
  ];
  for (const sql of drops) {
    assert.ok(!sqlWithoutComments(sql).includes("2019-11"), sql);
  }
  // And the real file: the R3 migration names the period only in its header.
  const r3 = read("supabase", "migrations", "20260817160000_kpi_period_lock_covers_money_writers.sql");
  assert.ok(r3.includes("2019-11"), "the R3 header no longer records the measured period");
  assert.ok(!sqlWithoutComments(r3).includes("2019-11"), "the R3 migration now executes on that period");
});

test("no two concurrency gates share a done-marker key", () => {
  // All of them lock the same classid and every one refuses to start if its key is
  // already held. Two gates sharing a key work only because the runner happens to
  // run them one at a time; the collision would surface as a precondition failure
  // or a barrier timeout in whichever ran second.
  const owners = new Map();
  for (const file of readdirSync(REPLAY_DIR).filter((name) => /_concurrency_.*\.sh$/.test(name))) {
    const text = readFileSync(path.join(REPLAY_DIR, file), "utf8");
    const classid = /^MARK_HI=([0-9]+)/m.exec(text);
    assert.ok(classid, `${file} takes no advisory done-marker`);
    const base = Number(/^MARK_LO=([0-9]+)/m.exec(text)?.[1]);
    assert.ok(Number.isInteger(base), `${file} declares no MARK_LO`);
    const keys = new Set([base]);
    for (const extra of text.matchAll(/^MARK_LO_[0-9]+=([0-9]+)/gm)) keys.add(Number(extra[1]));
    // 17_ derives its second marker arithmetically; that is still a key it owns.
    // Read from the lines that take or poll the lock — they name the classid too —
    // so a comment mentioning the arithmetic is not mistaken for a key in use.
    for (const line of text.split("\n").filter((one) => one.includes("MARK_HI"))) {
      for (const offset of line.matchAll(/MARK_LO \+ ([0-9]+)/g)) keys.add(base + Number(offset[1]));
    }
    for (const key of keys) {
      const held = owners.get(`${classid[1]}:${key}`);
      assert.equal(held, undefined, `${file} and ${held} both use done-marker key (${classid[1]}, ${key})`);
      owners.set(`${classid[1]}:${key}`, file);
    }
  }
  assert.ok(owners.size >= 7, `expected at least 7 distinct marker keys, found ${owners.size}`);
});
