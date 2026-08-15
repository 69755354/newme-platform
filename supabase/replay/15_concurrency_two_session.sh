#!/usr/bin/env bash
# ============================================================================
# Two-session concurrency gate for allocate_payment()
# ============================================================================
# Round-3 finding P1-7. The defect, quoted from the header of
# supabase/migrations/20260814000000_l0_round3_authorization_and_integrity.sql:
#
#   "allocate_payment() locked the payment and recomputed each plan's total with
#    an unlocked SUM. Reproduced with two concurrent sessions allocating 100 and
#    200 to plan 9111...1111: both returned success, allocated_amount was 200.00
#    and sum(amount_allocated) was 300.00."
#
# That reproduction was an ad-hoc run by hand. A lost update that was only ever
# observed by hand is not covered: nothing in the repository would notice if the
# `for update` in allocate_payment() were deleted again, because every existing
# assertion runs in ONE session and a single-session test cannot see a lost
# update at all. So the reproduction is now a committed gate that runs in both
# replay modes and is required to come out differently in each:
#
#   EXPECT=consistent  (MODE=branch, with the migrations)
#       both sessions succeed and installment_plans.allocated_amount equals
#       sum(payment_allocations.amount_allocated) — 300.00 = 300.00
#
#   EXPECT=lost        (MODE=control, the un-remediated floor)
#       both sessions succeed and the plan total is short by the first
#       allocation — 200.00 <> 300.00, the recorded defect
#
# Why the interleaving is deterministic and not a sleep
# ----------------------------------------------------
# Timing races make flaky gates, and a flaky "no lost update" gate is worse than
# none: the green run is indistinguishable from a run where the two sessions
# never actually overlapped. So the shell drives session A statement by statement
# over a pipe and uses the database's own lock state as the barrier:
#
#   1. A: begin, allocate 100 to the plan, then take an advisory lock as a
#      done-marker. A is now holding uncommitted work and waiting for more input,
#      which never arrives until step 4.
#   2. The coordinator polls pg_locks until that advisory lock is granted. This
#      is the proof that A finished its allocation and has not committed.
#   3. B: begin, allocate 200 to the SAME plan, commit. The coordinator polls
#      pg_locks until B is recorded as WAITING — on the floor B blocks on the
#      final UPDATE, having already computed its SUM without A's row; with the
#      migrations B blocks on the ordered `for update` BEFORE reading anything.
#      That difference is the entire finding, and both shapes register here as
#      "B is blocked on A", so the barrier does not assume either one.
#   4. Only then does the coordinator send A its COMMIT, which releases B.
#
# If either barrier is not reached inside the timeout the run FAILS with the
# session logs — it never falls through to measuring a verdict it did not
# actually stage. A gate that cannot stage the race must not report on it.
#
# Deadlock-free by construction: A waits on the shell, B waits on A, the shell
# waits on B's lock wait becoming visible. No cycle inside the database.
#
# Everything here is synthetic and scoped to three rows of its own (one
# installment plan, two payments) on the fixture contract from
# 05_seed_behaviour_fixtures.sql, and they are removed again at the end so the
# rollback assertions see the state the fixtures left. It runs as the harness
# superuser, so money_write_is_direct() is false and the write guards stand down
# for the fixture rows exactly as they do for 05_seed_behaviour_fixtures.sql.
#
# Requires: psql on PATH, PG* pointing at the throwaway replay database. Invoked
# by scripts/replay-migrations.sh; EXPECT is mandatory and has no default,
# because defaulting it is how a control run silently asserts the branch claim.
# ============================================================================
set -euo pipefail

: "${EXPECT:?EXPECT must be 'consistent' (with the migrations) or 'lost' (floor)}"
case "$EXPECT" in
  consistent|lost) ;;
  *) echo "concurrency gate: EXPECT must be 'consistent' or 'lost', got '$EXPECT'" >&2; exit 1 ;;
esac

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

# Fixed UUIDs, no random(): the assertions and the cleanup reference them by
# value, and a harness whose rows cannot be named cannot be cleaned up.
CONTRACT='c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'   # 05_seed_behaviour_fixtures.sql
ACTOR='ffffffff-ffff-ffff-ffff-ffffffffffff'      # replay-finance, role 'finance', active
PLAN='93333333-3333-3333-3333-333333333333'
PAY_A='d3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3'
PAY_B='d4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4'
AMOUNT_A='100.00'
AMOUNT_B='200.00'
EXPECTED_TOTAL='300.00'
MARK_HI=918273                                    # advisory done-marker for A
MARK_LO=645
BARRIER_TIMEOUT="${BARRIER_TIMEOUT:-90}"

work_dir="$(mktemp -d)"
out_a="$work_dir/session_a.log"
out_b="$work_dir/session_b.log"

PSQL_Q=(psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1)

fail() {
  echo "concurrency gate failed: $*" >&2
  exit 1
}

q() { "${PSQL_Q[@]}" -c "$1" | tr -d '[:space:]'; }

dump_sessions() {
  for log in "$out_a" "$out_b"; do
    [ -f "$log" ] || continue
    echo "--- $(basename "$log") ---" >&2
    cat "$log" >&2
  done
}

cleanup() {
  local status=$?
  # Close A's stdin if it is still open, so a failure between the barriers does
  # not leave a psql holding row locks in the replay database.
  if [ -n "${A_IN:-}" ]; then
    eval "exec ${A_IN}>&-" 2>/dev/null || true
  fi
  [ -n "${A_PID:-}" ] && wait "$A_PID" 2>/dev/null || true
  [ -n "${B_PID:-}" ] && wait "$B_PID" 2>/dev/null || true
  rm -rf "$work_dir"
  return $status
}
trap cleanup EXIT

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"

# ---------------------------------------------------------------------------
# Preconditions, asserted rather than assumed. Each of these being absent would
# otherwise show up as a confusing session error at a barrier.
# ---------------------------------------------------------------------------
[ "$(q "select count(*) from pg_proc
        where oid = to_regprocedure('public.allocate_payment(uuid, jsonb, uuid)')")" = "1" ] \
  || fail "public.allocate_payment(uuid, jsonb, uuid) is not present in this database"
[ "$(q "select count(*) from public.contracts where id = '$CONTRACT'")" = "1" ] \
  || fail "fixture contract $CONTRACT is missing; run 05_seed_behaviour_fixtures.sql first"
[ "$(q "select count(*) from public.profiles
        where id = '$ACTOR' and role = 'finance' and coalesce(is_active, false)")" = "1" ] \
  || fail "fixture actor $ACTOR is missing, not finance, or not active"

# ---------------------------------------------------------------------------
# Fixture rows for this gate only. One plan, two confirmed payments, both large
# enough for their allocation: allocate_payment() refuses to allocate more than
# the payment's amount, and (with the migrations) refuses an unconfirmed or
# voided payment outright.
# ---------------------------------------------------------------------------
cat >"$work_dir/setup.sql" <<SQL
delete from public.payments where id in ('$PAY_A', '$PAY_B');
delete from public.installment_plans where id = '$PLAN';
insert into public.installment_plans
  (id, contract_id, seq, amount, allocated_amount, due_date, status)
values
  ('$PLAN', '$CONTRACT', 93, 50000.00, 0, current_date, 'pending');
insert into public.payments
  (id, contract_id, amount, payment_date, confirmed, confirmed_by, confirmed_at, created_by)
values
  ('$PAY_A', '$CONTRACT', $AMOUNT_A, current_date, true, '$ACTOR', now(), '$ACTOR'),
  ('$PAY_B', '$CONTRACT', $AMOUNT_B, current_date, true, '$ACTOR', now(), '$ACTOR');
SQL

if ! psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
     -f "$work_dir/setup.sql" >"$work_dir/setup.log" 2>&1; then
  cat "$work_dir/setup.log" >&2
  fail "could not stage the concurrency fixtures"
fi

staged="$(q "select ip.allocated_amount from public.installment_plans ip where ip.id = '$PLAN'")"
[ "$staged" = "0.00" ] || fail "the fixture plan did not start empty (allocated_amount=$staged)"

echo "  staged plan $PLAN with two confirmed payments ($AMOUNT_A, $AMOUNT_B)"

# ---------------------------------------------------------------------------
# Session A, driven statement by statement over a pipe. A coprocess rather than
# a fifo: an anonymous pipe is what a `cmd | psql` pipeline already uses, so it
# works through every psql wrapper this harness has to run under.
# ---------------------------------------------------------------------------
coproc A_SESSION { psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 >"$out_a" 2>&1; }
A_IN="${A_SESSION[1]}"
A_PID="$A_SESSION_PID"

a_send() { printf '%s\n' "$1" >&"$A_IN" || true; }

a_send "set application_name = 'replay_concurrency_a';
        set idle_in_transaction_session_timeout = '${BARRIER_TIMEOUT}s';
        begin;
        select public.allocate_payment(
                 '$PAY_A',
                 '[{\"plan_id\": \"$PLAN\", \"amount\": $AMOUNT_A}]'::jsonb,
                 '$ACTOR');
        select pg_advisory_xact_lock($MARK_HI, $MARK_LO);"

wait_for() {
  local sql="$1" what="$2" deadline=$((SECONDS + BARRIER_TIMEOUT))
  while :; do
    if [ "$(q "$sql")" != "0" ]; then return 0; fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "concurrency gate: barrier never reached — $what" >&2
      dump_sessions
      return 1
    fi
    sleep 0.2
  done
}

# Barrier 1: A has allocated and is holding the work uncommitted.
wait_for "select count(*) from pg_locks
           where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO and granted" \
         "session A never finished its allocation (allocate_payment raised, or the session died)" \
  || fail "session A did not reach the hand-off point"

echo "  session A: allocated $AMOUNT_A, uncommitted"

# ---------------------------------------------------------------------------
# Session B, the whole transaction at once: it is meant to block inside the
# database, not to be steered. lock_timeout so a coordinator that dies leaves a
# failed session behind rather than a hung one.
# ---------------------------------------------------------------------------
cat >"$work_dir/session_b.sql" <<SQL
set application_name = 'replay_concurrency_b';
set lock_timeout = '${BARRIER_TIMEOUT}s';
begin;
select public.allocate_payment(
         '$PAY_B',
         '[{"plan_id": "$PLAN", "amount": $AMOUNT_B}]'::jsonb,
         '$ACTOR');
commit;
SQL

psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$work_dir/session_b.sql" >"$out_b" 2>&1 &
B_PID=$!

# Barrier 2: B is blocked, and blocked on A. Without this the two sessions could
# have run one after the other and the verdict would mean nothing.
wait_for "select count(*) from pg_locks l
            join pg_stat_activity s on s.pid = l.pid
           where not l.granted and s.application_name = 'replay_concurrency_b'" \
         "session B never blocked on session A, so the two allocations did not overlap" \
  || fail "the interleaving could not be staged"

blocked_on="$(q "select coalesce(string_agg(distinct l.locktype, ','), '')
                   from pg_locks l join pg_stat_activity s on s.pid = l.pid
                  where not l.granted and s.application_name = 'replay_concurrency_b'")"
echo "  session B: allocating $AMOUNT_B, blocked on A (waiting for a $blocked_on lock)"

# Hand-off: A commits, B proceeds.
a_send "commit;"
eval "exec ${A_IN}>&-"
A_IN=

wait "$A_PID" || { dump_sessions; fail "session A did not complete"; }
A_PID=
wait "$B_PID" || { dump_sessions; fail "session B did not complete"; }
B_PID=

for log in "$out_a" "$out_b"; do
  grep -q '"success"' "$log" || {
    dump_sessions
    fail "$(basename "$log") did not report a successful allocation"
  }
done

# ---------------------------------------------------------------------------
# The measurement. Both sessions said success; the question is whether the
# plan's cached total still agrees with the allocation rows that back it.
# ---------------------------------------------------------------------------
allocated="$(q "select ip.allocated_amount from public.installment_plans ip where ip.id = '$PLAN'")"
total="$(q "select coalesce(sum(pa.amount_allocated), 0.00)
              from public.payment_allocations pa where pa.plan_id = '$PLAN'")"
rows="$(q "select count(*) from public.payment_allocations pa where pa.plan_id = '$PLAN'")"

echo "  both sessions reported success"
echo "  plan $PLAN: allocated_amount=$allocated sum(payment_allocations)=$total over $rows row(s)"

# Cleanup before the verdict, so a failing gate still leaves the database in the
# state the fixtures created. payment_allocations.payment_id is ON DELETE
# CASCADE, so removing the payments removes their allocations.
cat >"$work_dir/teardown.sql" <<SQL
delete from public.payments where id in ('$PAY_A', '$PAY_B');
delete from public.installment_plans where id = '$PLAN';
SQL

if ! psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
     -f "$work_dir/teardown.sql" >"$work_dir/teardown.log" 2>&1; then
  cat "$work_dir/teardown.log" >&2
  fail "could not remove the concurrency fixtures"
fi

left="$(q "select (select count(*) from public.payments where id in ('$PAY_A', '$PAY_B'))
                + (select count(*) from public.installment_plans where id = '$PLAN')
                + (select count(*) from public.payment_allocations where plan_id = '$PLAN')")"
[ "$left" = "0" ] || fail "the concurrency fixtures did not clean up ($left row(s) left behind)"

[ "$rows" = "2" ] || fail "expected both allocation rows to survive, saw $rows"
[ "$total" = "$EXPECTED_TOTAL" ] \
  || fail "the two allocations should sum to $EXPECTED_TOTAL, saw $total — the race did not run as designed"

case "$EXPECT" in
  consistent)
    [ "$allocated" = "$total" ] || fail \
      "LOST UPDATE: both sessions succeeded but the plan records $allocated against $total of allocations. allocate_payment() is recomputing a plan total it does not hold a lock on"
    echo "  concurrency OK: serialized, allocated_amount=$allocated = sum=$total"
    ;;
  lost)
    if [ "$allocated" = "$total" ]; then
      fail "the un-remediated floor did NOT lose the update (allocated_amount=$allocated = sum=$total), so this gate proves nothing about the fix. Re-read the barriers above before changing the expectation"
    fi
    echo "  control OK: the floor lost an update — allocated_amount=$allocated, sum=$total"
    ;;
esac
