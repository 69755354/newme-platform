// ============================================================================
// Contract test for the two-session concurrency gate (round-3 P1-7)
// ============================================================================
// P1-7 was a lost update in allocate_payment(): it locked the payment and then
// recomputed each installment plan's total with an unlocked SUM, so two sessions
// allocating 100 and 200 to the same plan both succeeded and left the plan
// recording 200 against 300 of allocation rows. The migration fixed it with an
// ordered `for update` over every affected plan.
//
// The fix was verified by hand. This file exists because the verification has to
// survive the person who ran it: no assertion in
// supabase/replay/10_assert_release_contracts.sql can catch a regression here,
// since a lost update is invisible to a test that runs in one session, so
// deleting the `for update` again would leave every existing gate green.
//
// The gate itself needs a live database; what is checked here is everything
// about it that can be checked without one, and specifically the failure modes
// that would make it pass vacuously:
//
//   * it is wired into BOTH replay modes, with the expectations the right way
//     round — EXPECT=consistent with the migrations, EXPECT=lost against the
//     un-remediated floor. Swapping them, or wiring only the branch half, is how
//     a "no lost update" claim gets made about a database that never staged the
//     race.
//   * EXPECT has no default, so a mode that forgets to set it fails instead of
//     silently asserting the other mode's claim.
//   * the interleaving is staged against the database's own lock state, and both
//     barriers are hard failures. A gate sequenced by sleeps reports a verdict
//     for a race that may not have happened.
//   * the fix it is guarding is actually present in the migration.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const gate = await read("supabase/replay/15_concurrency_two_session.sh");
const runner = await read("scripts/replay-migrations.sh");
const migration = await read(
  "supabase/migrations/20260814000000_l0_round3_authorization_and_integrity.sql",
);

/** The runner body for one mode, so a wiring assertion cannot match the other. */
function modeBody(name) {
  const starts = {
    history: 'if [ "$MODE" = history ]; then',
    control: 'if [ "$MODE" = control ]; then',
    branch: "MODE=branch — the gate",
  };
  const from = runner.indexOf(starts[name]);
  assert.notEqual(from, -1, `could not find the ${name} mode block in scripts/replay-migrations.sh`);
  const ends = { history: starts.control, control: starts.branch, branch: null };
  const to = ends[name] ? runner.indexOf(ends[name], from) : runner.length;
  return runner.slice(from, to === -1 ? runner.length : to);
}

test("both replay modes run the concurrency gate, with opposite expectations", () => {
  const branch = modeBody("branch");
  const control = modeBody("control");

  assert.match(branch, /EXPECT=consistent bash "\$CONCURRENCY_GATE"/);
  assert.match(control, /EXPECT=lost bash "\$CONCURRENCY_GATE"/);

  // Neither mode may run the other's expectation.
  assert.doesNotMatch(branch, /EXPECT=lost/);
  assert.doesNotMatch(control, /EXPECT=consistent/);

  // And both must be gating, not informational: the invocation itself has to be
  // followed by `|| fail`, so its exit status cannot be swallowed.
  for (const [name, body] of [["branch", branch], ["control", control]]) {
    assert.match(
      body,
      /EXPECT=(?:consistent|lost) bash "\$CONCURRENCY_GATE"\s*\\?\s*\n?\s*\|\| fail /,
      `the ${name} mode does not fail when the concurrency gate fails`,
    );
  }

  assert.match(runner, /CONCURRENCY_GATE="\$REPLAY_DIR\/15_concurrency_two_session\.sh"/);
  assert.equal(
    (runner.match(/bash "\$CONCURRENCY_GATE"/g) ?? []).length,
    2,
    "the gate must be invoked exactly twice: once per gating mode",
  );
});

test("MODE=history does not run it, because there are no migrations to test", () => {
  assert.doesNotMatch(modeBody("history"), /CONCURRENCY_GATE/);
});

test("EXPECT is mandatory and closed to anything but the two verdicts", () => {
  // `${EXPECT:?}` — not `${EXPECT:-consistent}`. A default is how the control
  // half would end up asserting the branch claim against the floor and passing.
  assert.match(gate, /: "\$\{EXPECT:\?[^}]*\}"/);
  assert.doesNotMatch(gate, /EXPECT:-/);
  assert.match(gate, /case "\$EXPECT" in\s*\n\s*consistent\|lost\) ;;/);
  assert.match(gate, /EXPECT must be 'consistent' or 'lost'/);
});

test("the interleaving is staged from lock state, and each barrier is fatal", () => {
  // Barrier 1: A's advisory done-marker, proving it finished its allocation and
  // has not committed.
  assert.match(gate, /pg_advisory_xact_lock\(\$MARK_HI, \$MARK_LO\)/);
  assert.match(gate, /locktype = 'advisory' and classid = \$MARK_HI and objid = \$MARK_LO and granted/);
  // Barrier 2: B is recorded as waiting. `not l.granted`, attributed to B by
  // application_name, is what distinguishes an overlap from two sequential runs.
  assert.match(gate, /where not l\.granted and s\.application_name = 'replay_concurrency_b'/);

  // Both barriers must abort the run rather than fall through to a verdict.
  const barriers = [...gate.matchAll(/wait_for "([\s\S]*?)"\s*\\?\n(?:\s*"[\s\S]*?"\s*\\?\n)?\s*\|\| fail/g)];
  assert.equal(barriers.length, 2, "expected exactly two barriers, both guarded by || fail");

  // Sleep is allowed only as the poll interval inside wait_for, never as the
  // sequencing mechanism.
  const sleeps = [...gate.matchAll(/^\s*sleep .*$/gm)].map((m) => m[0].trim());
  assert.deepEqual(sleeps, ["sleep 0.2"], `unexpected sleep-based sequencing: ${sleeps.join(" | ")}`);
});

test("the gate measures the plan total against its allocation rows, not a return value", () => {
  // Both sessions returned success in the reproduction; the defect was only
  // visible in the disagreement between the cached total and the rows.
  assert.match(gate, /select ip\.allocated_amount from public\.installment_plans ip where ip\.id = '\$PLAN'/);
  assert.match(gate, /select coalesce\(sum\(pa\.amount_allocated\), 0\.00\)/);
  assert.match(gate, /EXPECTED_TOTAL='300\.00'/);
  // A run where one allocation vanished is not a pass in either direction.
  assert.match(gate, /\[ "\$rows" = "2" \]/);
  assert.match(gate, /\[ "\$total" = "\$EXPECTED_TOTAL" \]/);
  // consistent => equal; lost => not equal. Neither branch may be a no-op.
  assert.match(gate, /\[ "\$allocated" = "\$total" \] \|\| fail/);
  assert.match(gate, /if \[ "\$allocated" = "\$total" \]; then\s*\n\s*fail/);
});

test("the gate leaves the fixture state it found", () => {
  // It runs between the release assertions and the rollback, so rows it forgets
  // to remove become someone else's failing assertion.
  assert.match(gate, /delete from public\.payments where id in \('\$PAY_A', '\$PAY_B'\)/);
  assert.match(gate, /delete from public\.installment_plans where id = '\$PLAN'/);
  assert.match(gate, /\[ "\$left" = "0" \] \|\| fail/);
  // Its own rows only: the fixture contract and actor are read, never rewritten.
  assert.doesNotMatch(gate, /delete from public\.contracts/);
  assert.doesNotMatch(gate, /delete from public\.profiles/);
  assert.doesNotMatch(gate, /update public\.(contracts|profiles|payments)/);
});

test("the behaviour being guarded is the lock the migration added", () => {
  // If this block is ever removed the gate turns red against a real database;
  // asserting it here names the thing the gate is about.
  assert.match(
    migration,
    /perform 1 from public\.installment_plans\s*\n\s*where id = any \(v_affected\)\s*\n\s*order by id\s*\n\s*for update;/,
    "allocate_payment() must take an ordered row lock over every affected plan",
  );
  assert.match(migration, /select \* into v_payment from public\.payments where id = p_payment_id for update;/);
  // The reproduction the gate re-runs is recorded with its numbers.
  assert.match(migration, /allocated_amount was 200\.00 and sum\(amount_allocated\) was 300\.00/);
});

test("the gate is invoked through bash with the replay database's environment", () => {
  // No hardcoded connection, no secrets: it inherits the PG* variables the
  // runner already exported for the throwaway database.
  assert.match(gate, /: "\$\{PGDATABASE:=postgres\}"/);
  assert.match(gate, /export PGHOST PGPORT PGUSER PGDATABASE/);
  assert.doesNotMatch(gate, /PGPASSWORD|password=|postgres:\/\//);
});
