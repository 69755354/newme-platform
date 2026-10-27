// ============================================================================
// Contract test: the cash-predicate divergence is measured, in both postures
// ============================================================================
// R5. Seven read paths counted a payment as cash when `confirmed` was true, while
// every derived total in the database counts `confirmed = true and voided_at is
// null`. That difference is only a defect if a row can hold both — and one can:
// guard_payments_write() refuses void-column edits unconditionally but places its
// confirmed-immutability checks behind money_direct_write_is_blocked(), which is
// direct AND strict. So inside the compatibility window the contract's own
// salesperson can re-confirm a reversed payment with an ordinary UPDATE.
//
// supabase/replay/21_payment_predicate_divergence.sh is that reproduction, and this
// file is what keeps it one. The failure modes it guards against are the ones a
// passing run cannot show:
//
//   * the reproduction direction gets dropped, so only the "strict refuses it" half
//     runs — which is a claim about a row nobody has shown to be reachable;
//   * the verdict shrinks to "the guard is installed", a source-text claim wearing
//     a database's clothes;
//   * the staging drifts so that the two predicates already disagree before the
//     direct write, and the gate then measures its own fixture;
//   * the JavaScript half is left unbound, so "the routes were fixed" rests on the
//     database gate, which cannot see JavaScript.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { sqlWithoutComments } from "./sql-text.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const REPLAY_DIR = path.join(ROOT, "supabase", "replay");
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), "utf8");

const GATE_FILE = "21_payment_predicate_divergence.sh";
const gate = read("supabase", "replay", GATE_FILE);
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

test("both postures run, the reproduction first, and neither is optional", () => {
  const branch = modeBody("branch");
  assert.match(runner, /PREDICATE_GATE="\$REPLAY_DIR\/21_payment_predicate_divergence\.sh"/);
  assert.match(branch, /EXPECT=compat bash "\$PREDICATE_GATE"\s*\\\s*\n\s*\|\| fail /);
  assert.match(branch, /EXPECT=strict bash "\$PREDICATE_GATE"\s*\\\s*\n\s*\|\| fail /);
  assert.equal((runner.match(/bash "\$PREDICATE_GATE"/g) ?? []).length, 2);
  // The reproduction runs FIRST. If compat stops admitting the write, the finding is
  // closed in the database and the gate has to say so — a strict-only run would
  // report green for a state nobody can reach.
  assert.ok(
    branch.indexOf('EXPECT=compat bash "$PREDICATE_GATE"') <
      branch.indexOf('EXPECT=strict bash "$PREDICATE_GATE"'),
    "the compatibility-window reproduction must run before the strict claim",
  );
  assert.match(branch, /\[ -f "\$PREDICATE_GATE" \] \|\| fail /, "a missing gate must fail, not skip");
  // Neither other mode may run it: the un-remediated floor has no release mode at
  // all, so "compat" there is not a posture, it is an absence.
  assert.doesNotMatch(modeBody("control"), /PREDICATE_GATE/);
  assert.doesNotMatch(modeBody("history"), /PREDICATE_GATE/);
});

test("the gate has no default posture and accepts only the two it measures", () => {
  assert.match(gate, /: "\$\{EXPECT:\?[^}]*\}"/);
  assert.doesNotMatch(gate, /EXPECT:-/);
  assert.match(gate, /case "\$EXPECT" in\s*\n\s*compat\|strict\) ;;/);
  assert.match(gate, /EXPECT must be 'compat' or 'strict'/);
});

test("the row it measures is staged through the routines, and starts un-diverged", () => {
  // The reversal has to be one the application itself produces, or the gate is
  // measuring a hand-built row: confirm_payment() then void_payment(), both required
  // to report success, both as the server rather than as a direct write.
  assert.match(gate, /public\.confirm_payment\('\$PAYMENT', '\$FINANCE'\)/);
  assert.match(gate, /public\.void_payment\('\$PAYMENT', 'replay 21: predicate divergence gate'\)/);
  assert.equal((gate.match(/\*'"success"'\*\) ;;/g) ?? []).length, 2);
  assert.match(gate, /\[ "\$\(row_state\)" = "true\/live" \]/);
  assert.match(gate, /\[ "\$\(row_state\)" = "false\/voided" \]/);
  // And at that point the two predicates must AGREE. Without this the gate could
  // report a "divergence" that its own staging created.
  assert.match(gate, /the loose predicate already diverges after a routine-only reversal/);
  // The end-user session has to be able to see the row through RLS, or the direct
  // write could report success having matched nothing.
  assert.match(gate, /cannot see the staged payment through RLS/);
});

test("the verdict is the two predicates over the same rows, not the source text", () => {
  // Both spellings are computed from public.payments, so the comparison is between
  // two readings of the same money rather than against a second copy of a number.
  assert.match(gate, /ledger_of\(\) \{[\s\S]*?confirmed = true and voided_at is null"/);
  assert.match(gate, /loose_of\(\) \{[\s\S]*?and confirmed = true"/);

  const verdict = gate.slice(gate.indexOf('case "$EXPECT" in', gate.indexOf("The verdict")));
  // compat: the write is accepted, the row is contradictory, and the difference is
  // exactly the reversed payment. "Not equal" alone would also be satisfied by a
  // broken fixture, so both sides are pinned.
  assert.match(verdict, /\[ "\$state_after" = "true\/voided" \]/);
  assert.match(verdict, /\[ "\$ledger_after" = "0\.00" \]/);
  assert.match(verdict, /\[ "\$loose_after" = "\$AMOUNT" \]/);
  assert.match(verdict, /\[ "\$ledger_after" != "\$loose_after" \]/);
  // strict: the same statement, refused with the guard's own message, and the row
  // unmoved. A refusal that moves the row is not a refusal.
  assert.match(
    verdict,
    /expect_refusal "\$divergence_write" "42501" \\\s*\n\s*"payment confirmation, amount and linkage change through confirm_payment\(\) and allocate_payment\(\)"/,
  );
  assert.match(verdict, /\[ "\$state_after" = "false\/voided" \]/);
  assert.match(verdict, /\[ "\$ledger_after" = "0\.00" \] && \[ "\$loose_after" = "0\.00" \]/);
  // If compat ever stops admitting the write, the gate must say the finding is
  // closed rather than assert a reachable row it can no longer reach.
  assert.match(verdict, /the finding is closed in the database and this gate has to say so/);
});

test("the numbers are read back from a connection that never held the write", () => {
  // A committed divergence, not one session's snapshot: every scalar comes from its
  // own psql invocation, and the writing session is closed by then.
  assert.match(gate, /^q\(\) \{\n\s*psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "\$1"/m);
  assert.match(gate, /state_after="\$\(row_state\)"/);
  assert.match(gate, /ledger_after="\$\(ledger_of\)"/);
  assert.match(gate, /loose_after="\$\(loose_of\)"/);
  assert.ok(
    gate.indexOf('divergence_write="$(as_sales') < gate.indexOf('state_after="$(row_state)"'),
    "the state is read before the write, so the gate is not measuring read-after-write",
  );
});

test("the refusals are exact, and each is asked twice", () => {
  // SQLSTATE and message both, because "it raised" is not the claim. The messages
  // are the routines' own, so a rewording that changes what an operator is told
  // turns this red.
  assert.match(gate, /expect_refusal "\$got" "22023" "payment must be confirmed before allocation"/);
  assert.match(gate, /expect_refusal "\$got" "22023" "a voided payment cannot be confirmed"/);
  assert.match(gate, /expect_refusal "\$got" "42501" "a payment is voided through void_payment\(\)"/);
  assert.match(gate, /err\|\$state\|/, "the SQLSTATE is matched as a prefix, not searched for anywhere in the text");

  // Reentry: the second attempt must report the identical SQLSTATE and message. A
  // refusal that drifts on retry is one no client can be written against.
  assert.match(gate, /for pass in first second; do/);
  assert.match(gate, /\[ "\$alloc_second" = "\$alloc_first" \]/);
  assert.match(gate, /\[ "\$confirm_second" = "\$confirm_first" \]/);
  assert.match(gate, /the refusal is not idempotent/);

  // The allocation attempt carries a real plan and amount: allocate_payment()
  // validates the payload before it looks at the payment, so an empty array is
  // refused for the wrong reason (measured: 'allocations must be a non-empty array').
  assert.match(gate, /ALLOC_PAYLOAD="\[\{\\"plan_id\\": \\"\$PLAN\\", \\"amount\\": \\"1\.00\\"\}\]"/);
  assert.match(gate, /allocate_payment\('\$PAYMENT', '\$ALLOC_PAYLOAD'::jsonb/);
  assert.match(gate, /allocations must be a non-empty array/, "the reason this payload is not empty is recorded");
  // And a refused allocation must have moved nothing on the other side either.
  assert.match(gate, /a refused allocation left allocation rows behind/);
  assert.match(gate, /a refused allocation moved plan \$PLAN/);
});

test("the one-way reversal is measured before the posture is chosen", () => {
  // `update payments set voided_at = null` is refused in BOTH modes, which is what
  // makes the contradictory row buildable only by re-confirming. Asserted by
  // position: if it moved below the mode change it would be a claim about one
  // posture, and the gate's own header would be wrong.
  const unvoid = gate.indexOf("update public.payments set voided_at = null");
  const setMode = gate.indexOf("money_set_direct_write_mode('$EXPECT'");
  assert.notEqual(unvoid, -1, "the gate no longer tries to erase a reversal");
  assert.notEqual(setMode, -1);
  assert.ok(unvoid < setMode, "the un-void refusal is measured after the mode is staged, so it is no longer mode-independent");
  assert.match(gate, /a session cannot erase a reversal \(42501\), whatever the mode/);
});

test("the in-flight write is tied to the lock the phase flip takes exclusively", () => {
  // Identity, not count: re-taking money_release_mode_lock_key() inside the same
  // transaction must add no pg_locks row. A refcount bump is invisible there, so
  // this is the one form of the question with an observable answer — and it is what
  // connects this gate's write to the exclusive lock 17_/18_ measure.
  assert.match(gate, /select pg_advisory_xact_lock_shared\(public\.money_release_mode_lock_key\(\)\);/);
  assert.match(gate, /advisory_retake=' \|\| count\(\*\)/);
  assert.match(gate, /\[ "\$adv_retake" = "1" \]/);
  assert.match(gate, /so the lock the write holds is a DIFFERENT key and a mode flip would not wait for it/);
  // Zero before the write, exactly one after: without the "before" reading, one
  // pre-existing advisory lock would satisfy the assertion.
  assert.match(gate, /\[ "\$adv_before" = "0" \]/);
  assert.match(gate, /\[ "\$adv_after" = "1" \]/);
  // The write has to have taken effect inside its own transaction, or the lock could
  // have been taken by a statement that touched nothing.
  assert.match(gate, /\[ "\$adv_effect" = "1" \]/);

  // Interruption: the same write is rolled back and must leave nothing.
  assert.match(gate, /^rollback;$/m);
  assert.match(gate, /an interrupted direct write is not supposed to survive/);
  assert.match(gate, /the divergence is not committed state/);

  // No barriers, so no sequencing at all — and therefore no sleep. A sleep appearing
  // here would mean the gate had grown a race it is not staging from lock state.
  assert.deepEqual([...gate.matchAll(/^\s*sleep .*$/gm)].map((m) => m[0].trim()), []);
});

test("the gate refuses to run against a schema that cannot produce the behaviour", () => {
  // Every mechanism it needs is asserted present, so a missing migration is a red
  // gate rather than a green one measuring a floor.
  for (const sig of [
    "public.confirm_payment\\(uuid, uuid\\)",
    "public.void_payment\\(uuid, text\\)",
    "public.allocate_payment\\(uuid, jsonb, uuid\\)",
    "public.money_direct_write_mode\\(\\)",
    "public.money_set_direct_write_mode\\(text, text\\)",
    "public.money_direct_write_is_blocked\\(\\)",
    "public.money_release_mode_lock_key\\(\\)",
    "public.guard_payments_write\\(\\)",
  ]) {
    assert.match(gate, new RegExp(`'${sig}'`), `${sig} is no longer required to exist`);
  }
  assert.match(gate, /is not present in this database/);
  // The trigger has to be ATTACHED, not merely defined.
  assert.match(gate, /trg_guard_payments_write is not attached to public\.payments/);
  // And the end-user role has to hold the privilege the direct write needs, or a
  // refusal could be a missing grant wearing the guard's SQLSTATE.
  assert.match(gate, /has_table_privilege\('authenticated', 'public\.payments', 'UPDATE'\)::text"\)" = "true"/);
});

test("its footprint is one payment, and it proves it left nothing behind", () => {
  assert.match(gate, /delete from public\.payments where id = '\$PAYMENT';/);
  assert.match(gate, /the staged payment was left behind/);
  // The posture is restored to whatever it was invoked under, because the rollback
  // companions that run after it expect the strict posture the contract phase set.
  assert.match(gate, /money_set_direct_write_mode\('\$entry_mode'/);
  assert.match(gate, /instead of the '\$entry_mode' this gate found/);
  // Nothing it read may be rewritten, and the derived fields have to round-trip.
  assert.doesNotMatch(gate, /delete from public\.(contracts|profiles|installment_plans|kpi_targets|payment_allocations)\b/);
  assert.match(gate, /not the \$FP_ON_ENTRY it arrived with/);
  assert.match(gate, /not the \$ALLOCATED_ON_ENTRY it arrived with/);
  assert.match(gate, /this gate created kpi_targets rows for \$PERIOD/);
  assert.match(gate, /this gate created a projects row for \$CONTRACT/);
  // Cleanup runs before the verdict, so a failing gate still hands the rollback
  // assertions the state the fixtures created.
  assert.ok(
    gate.indexOf("teardown.sql") < gate.indexOf("The verdict"),
    "the fixtures are removed after the verdict, so a failure leaves them behind",
  );
  // No connection string, no password, no identity of its own.
  assert.doesNotMatch(gate, /PGPASSWORD|password=|postgres:\/\//);
  assert.match(gate, /export PGHOST PGPORT PGUSER PGDATABASE/);
});

test("the period and the payment it stages belong to no other file", () => {
  // Derived rather than asserted in prose: no other executable statement in the
  // replay set or the migrations may name this period or this payment id, or the
  // gate's own verdict could be about someone else's rows.
  const PERIOD = /^PERIOD='([0-9]{4}-[0-9]{2})'/m.exec(gate);
  const PAYMENT = /^PAYMENT='([0-9a-f-]{36})'/m.exec(gate);
  assert.ok(PERIOD, "the gate no longer pins its period");
  assert.ok(PAYMENT, "the gate no longer pins its payment id");
  const clashes = [];
  for (const dir of [REPLAY_DIR, path.join(ROOT, "supabase", "migrations")]) {
    for (const file of readdirSync(dir)) {
      if (file === GATE_FILE) continue;
      const text = readFileSync(path.join(dir, file), "utf8");
      const scanned = file.endsWith(".sql") ? sqlWithoutComments(text) : text;
      for (const value of [PERIOD[1], PAYMENT[1]]) {
        if (scanned.includes(value)) clashes.push(`${file}:${value}`);
      }
    }
  }
  assert.deepEqual(clashes, [], "another replay file or migration names this gate's period or payment");
});

test("the JavaScript half of the finding is bound to a test that executes it", () => {
  // A database gate cannot see JavaScript, and this one says so rather than letting
  // "the routes were fixed" rest on it. The named test has to exist and has to
  // execute the predicate over the row this gate stages.
  assert.match(gate, /tests\/security\/api-cache-money-boundary\.test\.mjs/);
  assert.match(gate, /It does not prove the routes were fixed/);
  const named = path.join(ROOT, "tests", "security", "api-cache-money-boundary.test.mjs");
  assert.ok(existsSync(named), "the test this gate defers the JavaScript half to does not exist");
  const js = readFileSync(named, "utf8");
  assert.match(
    js,
    /countsAsCash\(\{ confirmed: true, voided_at: "[^"]+" \}\),\s*\n?\s*false/,
    "the contradictory row this gate reproduces is not executed against the shared predicate",
  );
});
