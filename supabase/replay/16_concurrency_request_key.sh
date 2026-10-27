#!/usr/bin/env bash
# ============================================================================
# Two-session idempotency gate for the payment request key
# ============================================================================
# Round-4 finding B3, the half a single session cannot see.
#
# The finding as reproduced by hand: sending the same payment-creation request
# twice produced two payment rows of 7000.00 on the same contract, and the second
# was indistinguishable from a genuine second payment, so no reconciliation could
# ever tell them apart. Sequentially that is a missing uniqueness constraint, and
# the assertion file measures it (b3-the-same-request-twice-is-one-payment).
#
# Concurrently it is a different claim, and the one that actually matters: a
# double-submitted form, a retried fetch or a proxy replay arrives in two
# overlapping transactions, and a uniqueness rule enforced by a SELECT-then-INSERT
# in application code would let both through. Only an index enforces it under
# concurrency, and only two sessions can prove an index does.
#
#   EXPECT=unique     (MODE=branch, with the migrations)
#       the second inserter BLOCKS on idx_payments_request_key until the first
#       commits and then fails with 23505; exactly one payment exists
#
#   EXPECT=duplicate  (MODE=control, the un-remediated floor)
#       the second inserter does not block at all — it commits while the first
#       transaction is still open — and two payment rows exist for one request
#
# Same interleaving discipline as 15_concurrency_two_session.sh: session A is
# driven statement by statement over an anonymous pipe, and every barrier is a
# fact read out of the database rather than a sleep. The two modes need two
# different second barriers, because "blocked" is exactly the behaviour under
# test:
#
#   1. A: begin, insert the payment, take an advisory lock as a done-marker.
#      A is now holding an uncommitted row and waiting for input.
#   2. Poll pg_locks until that advisory lock is granted — proof that A inserted
#      and has not committed.
#   3. B: begin, insert the SAME request, commit.
#        EXPECT=unique    — poll pg_locks until B is recorded as WAITING. On the
#                           release B blocks on A's uncommitted index entry. B not
#                           blocking is NOT treated as a staging failure here: it
#                           is what a missing or non-unique index looks like, so
#                           the gate goes on to count the rows and reports the
#                           duplicate. Both facts are then required — one row AND
#                           B having waited AND B naming the index in its error.
#        EXPECT=duplicate — poll, from a third session that can only see
#                           committed rows, until B's row is visible. On the floor
#                           there is no index to block on, so B commits straight
#                           through while A is still open, which is the defect.
#   4. Only then does A commit.
#
# Either barrier not being reached inside the timeout FAILS the run with both
# session logs. A gate that cannot stage the race must not report on it.
#
# Each mode also asserts the schema it is measuring before it measures anything:
# EXPECT=unique requires payments.request_key and the partial unique index to
# exist, EXPECT=duplicate requires them to be absent. If the floor ever gains the
# column, the control fails loudly here instead of quietly measuring a race that
# is no longer the recorded one.
#
# Everything is synthetic, scoped to two payment rows of its own on the fixture
# contract from 05_seed_behaviour_fixtures.sql, and removed again at the end so
# the rollback assertions see the state the fixtures left. It runs as the harness
# superuser, so money_write_is_direct() is false and the write guards stand down
# exactly as they do for the fixtures; the guard's own "a payment must carry
# request_key" refusal is a session-level rule and is measured in
# 10_assert_release_contracts.sql. What this gate measures is the index.
#
# Requires: psql on PATH, PG* pointing at the throwaway replay database. Invoked
# by scripts/replay-migrations.sh; EXPECT is mandatory and has no default,
# because defaulting it is how a control run silently asserts the branch claim.
# ============================================================================
set -euo pipefail

: "${EXPECT:?EXPECT must be 'unique' (with the migrations) or 'duplicate' (floor)}"
case "$EXPECT" in
  unique|duplicate) ;;
  *) echo "request-key gate: EXPECT must be 'unique' or 'duplicate', got '$EXPECT'" >&2; exit 1 ;;
esac

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

# Fixed UUIDs, no random(): the verdict and the cleanup reference them by value.
CONTRACT='c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'   # 05_seed_behaviour_fixtures.sql
ACTOR='ffffffff-ffff-ffff-ffff-ffffffffffff'      # replay-finance, role 'finance', active
PAY_A='d7d7d7d7-0000-4000-8000-00000000000a'
PAY_B='d7d7d7d7-0000-4000-8000-00000000000b'
REQUEST_KEY='7e9ca57e-0000-4000-8000-000000000b33'
AMOUNT='7000.00'
MARK_HI=918273                                    # advisory done-marker for A
MARK_LO=646                                       # 645 belongs to the allocation gate
BARRIER_TIMEOUT="${BARRIER_TIMEOUT:-90}"
BLOCK_TIMEOUT="${BLOCK_TIMEOUT:-20}"
b_blocked=0

work_dir="$(mktemp -d)"
out_a="$work_dir/session_a.log"
out_b="$work_dir/session_b.log"

PSQL_Q=(psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1)

fail() {
  echo "request-key gate failed: $*" >&2
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
# Preconditions. The schema half is asserted per mode, so neither mode can end up
# measuring the other one's database.
# ---------------------------------------------------------------------------
[ "$(q "select count(*) from public.contracts where id = '$CONTRACT'")" = "1" ] \
  || fail "fixture contract $CONTRACT is missing; run 05_seed_behaviour_fixtures.sql first"
[ "$(q "select count(*) from public.profiles
        where id = '$ACTOR' and role = 'finance' and coalesce(is_active, false)")" = "1" ] \
  || fail "fixture actor $ACTOR is missing, not finance, or not active"

has_column="$(q "select count(*) from pg_attribute
                  where attrelid = 'public.payments'::regclass
                    and attname = 'request_key' and not attisdropped")"
has_index="$(q "select count(*) from pg_indexes
                 where schemaname = 'public' and tablename = 'payments'
                   and indexname = 'idx_payments_request_key'")"

case "$EXPECT" in
  unique)
    [ "$has_column" = "1" ] || fail "payments.request_key does not exist, so there is no idempotency boundary to test"
    [ "$has_index" = "1" ]  || fail "idx_payments_request_key does not exist, so nothing enforces the key under concurrency"
    ;;
  duplicate)
    [ "$has_column" = "0" ] && [ "$has_index" = "0" ] \
      || fail "the un-remediated floor already has request_key ($has_column) or its index ($has_index); this control would measure the wrong race"
    ;;
esac

# The column list differs by mode, and only by the key.
if [ "$has_column" = "1" ]; then
  COLS="(id, contract_id, amount, payment_date, created_by, request_key)"
  VAL_A="('$PAY_A', '$CONTRACT', $AMOUNT, current_date, '$ACTOR', '$REQUEST_KEY')"
  VAL_B="('$PAY_B', '$CONTRACT', $AMOUNT, current_date, '$ACTOR', '$REQUEST_KEY')"
else
  COLS="(id, contract_id, amount, payment_date, created_by)"
  VAL_A="('$PAY_A', '$CONTRACT', $AMOUNT, current_date, '$ACTOR')"
  VAL_B="('$PAY_B', '$CONTRACT', $AMOUNT, current_date, '$ACTOR')"
fi

# ---------------------------------------------------------------------------
# A clean slate for this gate's two rows.
# ---------------------------------------------------------------------------
if ! psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
     -c "delete from public.payments where id in ('$PAY_A', '$PAY_B')" \
     >"$work_dir/setup.log" 2>&1; then
  cat "$work_dir/setup.log" >&2
  fail "could not clear the request-key fixtures"
fi

echo "  staging one payment request ($AMOUNT on $CONTRACT) sent twice, concurrently"

# ---------------------------------------------------------------------------
# Session A, driven over a pipe.
# ---------------------------------------------------------------------------
coproc A_SESSION { psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 >"$out_a" 2>&1; }
A_IN="${A_SESSION[1]}"
A_PID="$A_SESSION_PID"

a_send() { printf '%s\n' "$1" >&"$A_IN" || true; }

a_send "set application_name = 'replay_reqkey_a';
        set idle_in_transaction_session_timeout = '${BARRIER_TIMEOUT}s';
        begin;
        insert into public.payments $COLS values $VAL_A;
        select pg_advisory_xact_lock($MARK_HI, $MARK_LO);"

wait_for() {
  local sql="$1" what="$2" deadline=$((SECONDS + BARRIER_TIMEOUT))
  while :; do
    if [ "$(q "$sql")" != "0" ]; then return 0; fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "request-key gate: barrier never reached — $what" >&2
      dump_sessions
      return 1
    fi
    sleep 0.2
  done
}

# Same poll, but a timeout is a measurement rather than a harness failure, and it
# is a short one because a session that is going to block does so immediately.
# EXPECT=unique needs this: "B never blocked" is the defect itself, so the gate
# must go on to count the rows and report the duplicate rather than exiting with
# "could not stage the interleaving", which reads like a broken harness.
poll_for() {
  local sql="$1" deadline=$((SECONDS + BLOCK_TIMEOUT))
  while :; do
    if [ "$(q "$sql")" != "0" ]; then return 0; fi
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 0.2
  done
}

# Barrier 1: A has inserted and is holding the row uncommitted.
wait_for "select count(*) from pg_locks
           where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO and granted" \
         "session A never finished its insert (it raised, or the session died)" \
  || fail "session A did not reach the hand-off point"

echo "  session A: inserted the payment, uncommitted"

# ---------------------------------------------------------------------------
# Session B: the same request again, as a whole transaction. It is meant either to
# block or to sail through, and which of those happens is the finding.
# ---------------------------------------------------------------------------
cat >"$work_dir/session_b.sql" <<SQL
set application_name = 'replay_reqkey_b';
set lock_timeout = '${BARRIER_TIMEOUT}s';
begin;
insert into public.payments $COLS values $VAL_B;
commit;
SQL

psql --no-psqlrc --quiet -f "$work_dir/session_b.sql" >"$out_b" 2>&1 &
B_PID=$!

# Barrier 2, one per mode. Both are readings, not sleeps.
case "$EXPECT" in
  unique)
    if poll_for "select count(*) from pg_locks l
                   join pg_stat_activity s on s.pid = l.pid
                  where not l.granted and s.application_name = 'replay_reqkey_b'"; then
      blocked_on="$(q "select coalesce(string_agg(distinct l.locktype, ','), '')
                         from pg_locks l join pg_stat_activity s on s.pid = l.pid
                        where not l.granted and s.application_name = 'replay_reqkey_b'")"
      echo "  session B: sent the same request, blocked on A (waiting for a $blocked_on lock)"
      b_blocked=1
    else
      # Not a staging problem: nothing to block on is what a missing or
      # non-unique index looks like. Fall through and count what was written.
      echo "  session B: sent the same request and did NOT block within ${BLOCK_TIMEOUT}s"
      b_blocked=0
    fi
    ;;
  duplicate)
    # This query runs in its own session, so it can only see committed rows: B's
    # row being visible while A is still open is proof that B did not block.
    wait_for "select count(*) from public.payments where id = '$PAY_B'" \
             "session B did not commit while A was open, so the floor did block after all" \
      || fail "the control could not stage an unserialized duplicate"
    echo "  session B: sent the same request and committed while A was still open"
    ;;
esac

# Hand-off: A commits.
a_send "commit;"
eval "exec ${A_IN}>&-"
A_IN=

wait "$A_PID" || { dump_sessions; fail "session A did not complete"; }
A_PID=
# B is expected to fail in EXPECT=unique, so its exit status is not the verdict.
wait "$B_PID" 2>/dev/null || true
B_PID=

if grep -qi 'error' "$out_a"; then
  dump_sessions
  fail "session A reported an error; the first of the two requests must succeed"
fi

# ---------------------------------------------------------------------------
# The measurement: how many payments now exist for one request.
# ---------------------------------------------------------------------------
if [ "$has_column" = "1" ]; then
  rows="$(q "select count(*) from public.payments
              where created_by = '$ACTOR' and request_key = '$REQUEST_KEY'")"
else
  rows="$(q "select count(*) from public.payments where id in ('$PAY_A', '$PAY_B')")"
fi
b_refused="$(grep -c 'idx_payments_request_key' "$out_b" || true)"

echo "  payments recorded for one request: $rows"

# Cleanup before the verdict, so a failing gate still leaves the database in the
# state the fixtures created.
if ! psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
     -c "delete from public.payments where id in ('$PAY_A', '$PAY_B')" \
     >"$work_dir/teardown.log" 2>&1; then
  cat "$work_dir/teardown.log" >&2
  fail "could not remove the request-key fixtures"
fi

left="$(q "select count(*) from public.payments where id in ('$PAY_A', '$PAY_B')")"
[ "$left" = "0" ] || fail "the request-key fixtures did not clean up ($left row(s) left behind)"

case "$EXPECT" in
  unique)
    [ "$rows" = "1" ] || {
      dump_sessions
      fail "DUPLICATE REQUEST: one request produced $rows payment rows (session B blocked: $b_blocked). idx_payments_request_key is not enforcing (created_by, request_key) under concurrency"
    }
    [ "$b_blocked" = "1" ] || {
      dump_sessions
      fail "only one payment exists, but session B never waited on A — so nothing was serialized and this run does not show the index doing the work"
    }
    [ "$b_refused" != "0" ] || {
      dump_sessions
      fail "only one payment exists, but session B did not report a unique violation on idx_payments_request_key — the second request was lost for some other reason, and this gate would not notice the index disappearing"
    }
    echo "  idempotency OK: the second concurrent request was refused by idx_payments_request_key, one payment recorded"
    ;;
  duplicate)
    [ "$rows" = "2" ] || fail "the un-remediated floor did NOT duplicate the request ($rows row(s)), so this gate proves nothing about the fix. Re-read the barriers above before changing the expectation"
    echo "  control OK: the floor recorded one request twice — $rows payments"
    ;;
esac
