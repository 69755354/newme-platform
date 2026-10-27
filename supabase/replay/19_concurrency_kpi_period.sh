#!/usr/bin/env bash
# ============================================================================
# Two-session concurrency gate for the kpi_targets period lock (R3)
# ============================================================================
# 20260817000000 §14 gave replace_kpi_targets() a period lock and 20260817150000
# gave clear_kpi_targets() the same one. Both files describe it as serializing "a
# save and a clear of one period" — which is what it did, and is also the gap:
# confirm_payment() and void_payment(), the two routines that actually move money
# into and out of kpi_targets.actual_amount, wrote the same period's rows and took
# no lock at all. 20260817160000_kpi_period_lock_covers_money_writers.sql closes
# that; this gate is the reproduction it closes.
#
# Neither direction is reachable from one session. Sequentially a target edit and
# a confirmation are two operations that both end with the arithmetic anyone would
# expect; the defect only exists in the overlap, and no assertion in
# 10_assert_release_contracts.sql can stage an overlap.
#
#   EXPECT=serialized  (the migration applied, nothing mutated)
#       stage 1  the confirmation waits on the SAVE's advisory lock, then commits
#                on top of the row the save re-inserted:  actual 0.00 -> 4321.00,
#                equal to the period's confirmed, un-voided ledger.
#       stage 2  the void waits on the same lock, then debits the row the save
#                re-inserted:  actual 4321.00 -> 0.00, equal to the ledger again.
#
#   EXPECT=lost  (the two period-lock lines removed from the live definitions)
#       stage 1  the confirmation runs straight into kpi_targets, blocks on the
#                row lock the save's DELETE holds, and after the save commits its
#                UPDATE matches nothing — the row it was aiming at is gone and the
#                replacement carries the pre-confirm snapshot:  actual 0.00 ->
#                0.00 against a ledger of 4321.00. confirm_payment reports
#                success. Nothing recomputes actual_amount from payments, so the
#                collection is gone from the KPI permanently.
#       stage 2  the mirror: the void's debit matches nothing, the replacement
#                carries the pre-void 4321.00 forward, and the KPI still credits a
#                payment that has been voided:  actual 4321.00 against a ledger of
#                0.00.
#
# So both directions END with a comparison between kpi_targets.actual_amount and
# the ledger it is supposed to summarise, and they disagree in opposite ways. The
# gate never asserts "the lock is there"; it asserts what the lock is for.
#
# Why the control is a mutation and not MODE=control
# --------------------------------------------------
# The same reason 17_concurrency_mode_flip.sh gives. The un-remediated floor has
# no B7 carry-forward, so on the floor a target save resets actuals to zero
# whether or not anything raced it — the floor cannot distinguish this finding
# from the one B7 already closed. So both directions run here, against this
# schema, and the mutant is derived from the live definitions: captured with
# pg_get_functiondef(), the single `perform pg_advisory_xact_lock(...)` line
# removed from each, restored from the capture afterwards, and the restore is
# required to be byte-identical. The mutant is therefore exactly "this release
# without R3" rather than a hand-written imitation of it. EXPECT=lost runs FIRST,
# so a failed restore turns the serialized run immediately red instead of letting
# the rest of the harness measure a mutated database.
#
# Why the interleaving is deterministic and not a sleep
# ----------------------------------------------------
# Same barrier design as 15_concurrency_two_session.sh: session A is driven
# statement by statement over a pipe and takes an advisory done-marker as its last
# statement, the coordinator polls pg_locks until that marker is granted (proof
# that A has finished its target save and has not committed), then starts the
# money session and polls pg_locks until it is recorded WAITING before releasing
# A. If a barrier is not reached inside the timeout the gate FAILS with both
# session logs rather than falling through to a verdict it did not stage.
#
# The waiting session's locktype is asserted too, because it is what distinguishes
# the two mechanisms and a gate that cannot tell them apart is measuring luck:
#   serialized -> the money session waits on an `advisory` lock, before it has
#                 read kpi_targets at all.
#   lost       -> it waits on a row lock (`transactionid`/`tuple`) taken by the
#                 save's DELETE, having already committed its own money writes.
#
# Deadlock-free by construction: A waits on the shell, the money session waits on
# A, the shell waits on that wait becoming visible. No cycle inside the database.
#
# Footprint: one kpi_targets row and one payment, in a period (2019-11) that no
# fixture and no assertion uses, on fixture contract C4 — which has no projects
# row and whose first_payment_status is already 'unpaid', so neither routine's
# cascade writes anything outside this gate's own two rows. Both are removed at
# the end and the removal is verified, so the rollback assertions see the state
# 05_seed_behaviour_fixtures.sql left. The gate also records C4's
# first_payment_status on entry and requires it back on exit.
#
# Requires: psql on PATH, PG* pointing at the throwaway replay database. Invoked
# by scripts/replay-migrations.sh; EXPECT is mandatory and has no default, because
# defaulting it is how a control run silently asserts the branch claim.
# ============================================================================
set -euo pipefail

: "${EXPECT:?EXPECT must be 'serialized' (with the period lock) or 'lost' (the lock lines removed)}"
case "$EXPECT" in
  serialized|lost) ;;
  *) echo "kpi period gate: EXPECT must be 'serialized' or 'lost', got '$EXPECT'" >&2; exit 1 ;;
esac

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

# Fixed values, no random(): the assertions and the cleanup name their rows.
CONTRACT='c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4'   # 05_seed_behaviour_fixtures.sql, no projects row
SALES='cccccccc-cccc-cccc-cccc-cccccccccccc'      # C4.sales_id, the credited salesperson
FINANCE='ffffffff-ffff-ffff-ffff-ffffffffffff'    # replay-finance, role 'finance', active
ADMIN='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'      # replay-admin, the set_by of a target save
PAYMENT='d9d9d9d9-d9d9-d9d9-d9d9-d9d9d9d9d9d9'
PERIOD='2019-11'                                  # used by no fixture and no assertion
PAY_DATE='2019-11-15'
AMOUNT='4321.00'
TARGET='500000.00'
MARK_HI=918273                                    # advisory done-marker, same classid as the other
MARK_LO=651                                       # gates: 645 (15_), 646 (16_), 648 and 649 (17_,
MARK_LO_2=652                                     # which derives its second as MARK_LO + 1), 650 (18_)
BARRIER_TIMEOUT="${BARRIER_TIMEOUT:-90}"

work_dir="$(mktemp -d)"
out_a="$work_dir/session_save.log"
out_b="$work_dir/session_money.log"
mutated=0

PSQL_Q=(psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1)

fail() {
  echo "kpi period gate failed: $*" >&2
  exit 1
}

q() { "${PSQL_Q[@]}" -c "$1" | tr -d '[:space:]'; }
q_raw() { "${PSQL_Q[@]}" -c "$1"; }

dump_sessions() {
  for log in "$out_a" "$out_b"; do
    [ -f "$log" ] || continue
    echo "--- $(basename "$log") ---" >&2
    cat "$log" >&2
  done
}

# ---------------------------------------------------------------------------
# The mutation has to be undoable before it is made, and the undo has to be
# verified rather than assumed.
# ---------------------------------------------------------------------------
restore_routines() {
  [ "$mutated" = "1" ] || return 0
  local sig
  for sig in confirm void; do
    [ -s "$work_dir/${sig}_orig.sql" ] || {
      echo "kpi period gate: the captured ${sig}_payment definition is missing; the mutation cannot be undone" >&2
      return 1
    }
  done
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/confirm_orig.sql" -f "$work_dir/void_orig.sql" \
    >"$work_dir/restore.log" 2>&1 || {
    cat "$work_dir/restore.log" >&2
    return 1
  }
  mutated=0
  local now_confirm now_void
  now_confirm="$(q_raw "select pg_get_functiondef('public.confirm_payment(uuid, uuid)'::regprocedure)")"
  now_void="$(q_raw "select pg_get_functiondef('public.void_payment(uuid, text)'::regprocedure)")"
  [ "$now_confirm" = "$CONFIRM_DEF" ] || {
    echo "kpi period gate: confirm_payment was restored but is not byte-identical to the definition captured on entry" >&2
    return 1
  }
  [ "$now_void" = "$VOID_DEF" ] || {
    echo "kpi period gate: void_payment was restored but is not byte-identical to the definition captured on entry" >&2
    return 1
  }
  return 0
}

cleanup() {
  local status=$?
  # Close the save session's stdin if it is still open, so a failure between the
  # barriers does not leave a psql holding the period lock and row locks.
  if [ -n "${A_IN:-}" ]; then
    eval "exec ${A_IN}>&-" 2>/dev/null || true
  fi
  [ -n "${A_PID:-}" ] && wait "$A_PID" 2>/dev/null || true
  [ -n "${B_PID:-}" ] && wait "$B_PID" 2>/dev/null || true
  restore_routines || status=1
  rm -rf "$work_dir"
  return $status
}
trap cleanup EXIT

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"

# ---------------------------------------------------------------------------
# Preconditions, asserted rather than assumed.
# ---------------------------------------------------------------------------
for sig in 'public.replace_kpi_targets(text, jsonb, uuid)' \
           'public.confirm_payment(uuid, uuid)' \
           'public.void_payment(uuid, text)'; do
  [ "$(q "select count(*) from pg_proc where oid = to_regprocedure('$sig')")" = "1" ] \
    || fail "$sig is not present in this database"
done
[ "$(q "select count(*) from public.contracts
        where id = '$CONTRACT' and sales_id = '$SALES'")" = "1" ] \
  || fail "fixture contract $CONTRACT is missing or is not owned by $SALES"
[ "$(q "select count(*) from public.projects where contract_id = '$CONTRACT'")" = "0" ] \
  || fail "fixture contract $CONTRACT has acquired a projects row; this gate assumes it has none"
for who in "$SALES" "$FINANCE" "$ADMIN"; do
  [ "$(q "select count(*) from public.profiles
          where id = '$who' and coalesce(is_active, false)")" = "1" ] \
    || fail "fixture profile $who is missing or not active"
done
[ "$(q "select count(*) from public.kpi_targets where period = '$PERIOD'")" = "0" ] \
  || fail "period $PERIOD already has target rows; this gate measures rows it staged itself"
for lo in "$MARK_LO" "$MARK_LO_2"; do
  [ "$(q "select count(*) from pg_locks
           where locktype = 'advisory' and classid = $MARK_HI and objid = $lo")" = "0" ] \
    || fail "the done-marker key ($MARK_HI, $lo) is already locked by someone else"
done

FP_ON_ENTRY="$(q "select coalesce(first_payment_status, '<null>')
                    from public.contracts where id = '$CONTRACT'")"

# ---------------------------------------------------------------------------
# Capture, then (for the control) mutate. The mutant is the live definition minus
# the one line that takes the period lock — nothing else — so a green control run
# cannot be a run against a differently-shaped routine.
# ---------------------------------------------------------------------------
CONFIRM_DEF="$(q_raw "select pg_get_functiondef('public.confirm_payment(uuid, uuid)'::regprocedure)")"
VOID_DEF="$(q_raw "select pg_get_functiondef('public.void_payment(uuid, text)'::regprocedure)")"
[ -n "$CONFIRM_DEF" ] && [ -n "$VOID_DEF" ] \
  || fail "could not capture the money routine definitions, so a mutation could not be undone"
{ printf '%s\n' "$CONFIRM_DEF"; printf ';\n'; } >"$work_dir/confirm_orig.sql"
{ printf '%s\n' "$VOID_DEF"; printf ';\n'; } >"$work_dir/void_orig.sql"

LOCK_LINE="pg_advisory_xact_lock(hashtextextended('public.kpi_targets:'"

if [ "$EXPECT" = "serialized" ]; then
  for f in confirm void; do
    [ "$(grep -c -F "$LOCK_LINE" "$work_dir/${f}_orig.sql" || true)" = "1" ] \
      || fail "${f}_payment does not take the kpi period lock exactly once in this database, so EXPECT=serialized would be asserting something that is not installed"
  done
else
  for f in confirm void; do
    grep -v -F "$LOCK_LINE" "$work_dir/${f}_orig.sql" >"$work_dir/${f}_mutant.sql"
    before="$(wc -l <"$work_dir/${f}_orig.sql")"
    after="$(wc -l <"$work_dir/${f}_mutant.sql")"
    [ "$((before - after))" = "1" ] \
      || fail "removing the period lock from ${f}_payment took $((before - after)) line(s) instead of exactly 1; the control's mutation is not what it says it is"
  done
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/confirm_mutant.sql" -f "$work_dir/void_mutant.sql" \
    >"$work_dir/mutate.log" 2>&1 || {
    cat "$work_dir/mutate.log" >&2
    fail "could not install the lock-free money routines for the control"
  }
  mutated=1
  for f in confirm void; do
    sig="public.${f}_payment(uuid, uuid)"
    [ "$f" = "void" ] && sig="public.void_payment(uuid, text)"
    [ "$(q "select case when pg_get_functiondef('$sig'::regprocedure)
                        like '%hashtextextended(''public.kpi_targets:''%'
                   then 1 else 0 end")" = "0" ] \
      || fail "${f}_payment still contains the period lock after the mutation"
  done
  echo "  control: confirm_payment() and void_payment() replaced with their live definitions minus the period lock"
fi

# ---------------------------------------------------------------------------
# This gate's two rows. The target starts at zero actuals, which is the state a
# period is in before anything is collected against it.
# ---------------------------------------------------------------------------
cat >"$work_dir/setup.sql" <<SQL
delete from public.payments where id = '$PAYMENT';
delete from public.kpi_targets where period = '$PERIOD';
insert into public.kpi_targets (period, target_type, target_amount, actual_amount, assigned_to, set_by)
values ('$PERIOD', 'collection', $TARGET, 0, '$SALES', '$ADMIN');
insert into public.payments (id, contract_id, amount, payment_date, confirmed, created_by)
values ('$PAYMENT', '$CONTRACT', $AMOUNT, '$PAY_DATE', false, '$SALES');
SQL

if ! psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
     -f "$work_dir/setup.sql" >"$work_dir/setup.log" 2>&1; then
  cat "$work_dir/setup.log" >&2
  fail "could not stage the kpi period fixtures"
fi

kpi_of() {
  q "select actual_amount from public.kpi_targets
      where period = '$PERIOD' and target_type = 'collection' and assigned_to = '$SALES'"
}
ledger_of() {
  q "select coalesce(sum(p.amount), 0.00)
       from public.payments p
       join public.contracts c on c.id = p.contract_id
      where to_char(p.payment_date, 'YYYY-MM') = '$PERIOD'
        and c.sales_id = '$SALES'
        and p.confirmed = true
        and p.voided_at is null"
}

[ "$(kpi_of)" = "0.00" ] || fail "the staged target did not start at 0.00 (actual_amount=$(kpi_of))"
[ "$(ledger_of)" = "0.00" ] || fail "period $PERIOD did not start with an empty ledger"

echo "  staged target ($PERIOD, collection, $SALES) at 0.00 and one unconfirmed payment of $AMOUNT"

# ---------------------------------------------------------------------------
# The save session, driven statement by statement over a pipe. A coprocess rather
# than a fifo: an anonymous pipe is what a `cmd | psql` pipeline already uses, so
# it works through every psql wrapper this harness has to run under.
#
# No request.jwt.claims: replace_kpi_targets() is called by the server, and
# assert_current_session_at_entry() passes a session with no end-user identity.
# ---------------------------------------------------------------------------
coproc A_SESSION { psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 >"$out_a" 2>&1; }
A_IN="${A_SESSION[1]}"
A_PID="$A_SESSION_PID"

a_send() { printf '%s\n' "$1" >&"$A_IN" || true; }

wait_for() {
  local sql="$1" what="$2" deadline=$((SECONDS + BARRIER_TIMEOUT))
  while :; do
    if [ "$(q "$sql")" != "0" ]; then return 0; fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "kpi period gate: barrier never reached — $what" >&2
      dump_sessions
      return 1
    fi
    sleep 0.2
  done
}

# The replacement keeps the (collection, SALES) pair, so B7 carries its actuals
# forward: the only way the amount can be lost is the race this gate stages.
save_payload="[{\"target_type\": \"collection\", \"assigned_to\": \"$SALES\", \"target_amount\": \"$TARGET\"}]"

start_save() {
  local marker="$1" label="$2"
  a_send "set application_name = 'replay_kpi_save';
          set idle_in_transaction_session_timeout = '${BARRIER_TIMEOUT}s';
          begin;
          select count(*) from public.replace_kpi_targets(
                   '$PERIOD', '$save_payload'::jsonb, '$ADMIN');
          select pg_advisory_xact_lock($MARK_HI, $marker);"
  wait_for "select count(*) from pg_locks
             where locktype = 'advisory' and classid = $MARK_HI and objid = $marker and granted" \
           "the target save never completed ($label): replace_kpi_targets raised, or the session died" \
    || fail "the save session did not reach the hand-off point ($label)"
}

# The money session runs as one transaction: it is meant to block inside the
# database, not to be steered. lock_timeout so a coordinator that dies leaves a
# failed session behind rather than a hung one.
#
# void_payment() takes no actor parameter — it resolves the actor from the session
# — so the money session carries the claim shape GoTrue issues, which is also how
# the application reaches both routines. current_user stays the harness role, so
# money_write_is_direct() is false and the write guards stand down exactly as they
# do for the fixtures.
start_money() {
  local sql="$1"
  cat >"$work_dir/session_money.sql" <<SQL
set application_name = 'replay_kpi_money';
set lock_timeout = '${BARRIER_TIMEOUT}s';
begin;
select set_config('request.jwt.claims',
                  json_build_object('sub', '$FINANCE', 'role', 'authenticated',
                                    'iat', floor(extract(epoch from now()))::bigint)::text,
                  true);
$sql
commit;
SQL
  : >"$out_b"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$work_dir/session_money.sql" >"$out_b" 2>&1 &
  B_PID=$!
}

# The waiting session's locktype IS the mechanism. Asserted, not just printed.
await_money_blocked() {
  local label="$1"
  wait_for "select count(*) from pg_locks l
              join pg_stat_activity s on s.pid = l.pid
             where not l.granted and s.application_name = 'replay_kpi_money'" \
           "the money session never blocked on the target save ($label), so the two never overlapped" \
    || fail "the interleaving could not be staged ($label)"

  local kinds
  kinds="$(q "select coalesce(string_agg(distinct l.locktype, ',' order by l.locktype), '')
                from pg_locks l join pg_stat_activity s on s.pid = l.pid
               where not l.granted and s.application_name = 'replay_kpi_money'")"
  echo "  $label: the money session is blocked on the save (waiting for: $kinds)"
  case "$EXPECT" in
    serialized)
      case ",$kinds," in
        *,advisory,*) ;;
        *) fail "$label: the money session is waiting on '$kinds', not on the period's advisory lock — with the migration applied it must not reach kpi_targets before the save commits" ;;
      esac
      ;;
    lost)
      case ",$kinds," in
        *,advisory,*) fail "$label: the lock-free control is waiting on an advisory lock, so the mutation did not remove the period lock" ;;
      esac
      case ",$kinds," in
        *,transactionid,*|*,tuple,*) ;;
        *) fail "$label: the lock-free control is waiting on '$kinds'; it should be blocked on the row lock the save's DELETE holds" ;;
      esac
      ;;
  esac
}

release_save() {
  a_send "commit;"
}

# ===========================================================================
# Stage 1 — the credit. A confirmation that overlaps a save of its own period.
# ===========================================================================
start_save "$MARK_LO" "stage 1"
echo "  stage 1: the period was saved and is held uncommitted"
start_money "select public.confirm_payment('$PAYMENT', '$FINANCE');"
await_money_blocked "stage 1"
release_save

wait "$B_PID" || { dump_sessions; fail "the confirmation did not complete"; }
B_PID=
grep -q '"success"' "$out_b" || { dump_sessions; fail "confirm_payment did not report success"; }
mv "$out_b" "$work_dir/session_money_stage1.log"

kpi_1="$(kpi_of)"
ledger_1="$(ledger_of)"
echo "  stage 1: confirm_payment reported success; actual_amount=$kpi_1 ledger=$ledger_1"

[ "$ledger_1" = "$AMOUNT" ] \
  || fail "stage 1 left a ledger of $ledger_1 instead of $AMOUNT — the race did not run as designed"
[ "$(q "select count(*) from public.kpi_targets where period = '$PERIOD'")" = "1" ] \
  || fail "stage 1 left more than one target row for $PERIOD"

# ---------------------------------------------------------------------------
# Between the stages, the target is set to the value the ledger says it should
# hold, so stage 2 starts from identical state in both directions and measures
# the debit rather than inheriting stage 1's verdict. Staging, not measuring.
# ---------------------------------------------------------------------------
normalised="$(q "with upd as (
                   update public.kpi_targets set actual_amount = $AMOUNT
                    where period = '$PERIOD' and target_type = 'collection'
                      and assigned_to = '$SALES'
                    returning 1)
                 select count(*) from upd")"
[ "$normalised" = "1" ] || fail "could not normalise the target before stage 2 (rows updated: $normalised)"

# ===========================================================================
# Stage 2 — the debit. A void that overlaps a save of its own period.
# ===========================================================================
A_MARK_2="$MARK_LO_2"
start_save "$A_MARK_2" "stage 2"
echo "  stage 2: the period was saved again and is held uncommitted (carrying $AMOUNT forward)"
start_money "select public.void_payment('$PAYMENT', 'replay 19: kpi period lock gate');"
await_money_blocked "stage 2"
release_save

# Close the save session for good and let both finish.
eval "exec ${A_IN}>&-"
A_IN=
wait "$A_PID" || { dump_sessions; fail "the save session did not complete"; }
A_PID=
wait "$B_PID" || { dump_sessions; fail "the void did not complete"; }
B_PID=
grep -q '"success"' "$out_b" || { dump_sessions; fail "void_payment did not report success"; }

kpi_2="$(kpi_of)"
ledger_2="$(ledger_of)"
echo "  stage 2: void_payment reported success; actual_amount=$kpi_2 ledger=$ledger_2"

[ "$ledger_2" = "0.00" ] \
  || fail "stage 2 left a ledger of $ledger_2 instead of 0.00 — the void did not take effect at all"

# ---------------------------------------------------------------------------
# Cleanup before the verdict, so a failing gate still leaves the database in the
# state the fixtures created.
# ---------------------------------------------------------------------------
cat >"$work_dir/teardown.sql" <<SQL
delete from public.payments where id = '$PAYMENT';
delete from public.kpi_targets where period = '$PERIOD';
SQL
if ! psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
     -f "$work_dir/teardown.sql" >"$work_dir/teardown.log" 2>&1; then
  cat "$work_dir/teardown.log" >&2
  fail "could not remove the kpi period fixtures"
fi

left="$(q "select (select count(*) from public.payments where id = '$PAYMENT')
                + (select count(*) from public.kpi_targets where period = '$PERIOD')")"
[ "$left" = "0" ] || fail "the kpi period fixtures did not clean up ($left row(s) left behind)"
[ "$(q "select count(*) from public.projects where contract_id = '$CONTRACT'")" = "0" ] \
  || fail "this gate created a projects row for $CONTRACT"
fp_on_exit="$(q "select coalesce(first_payment_status, '<null>')
                   from public.contracts where id = '$CONTRACT'")"
[ "$fp_on_exit" = "$FP_ON_ENTRY" ] \
  || fail "contract $CONTRACT left this gate with first_payment_status=$fp_on_exit, not the $FP_ON_ENTRY it arrived with"

restore_routines || fail "could not restore confirm_payment()/void_payment() after the control's mutation"

# ---------------------------------------------------------------------------
# The verdict. Both money operations reported success in both directions; the
# question is whether kpi_targets.actual_amount still agrees with the ledger it
# summarises.
# ---------------------------------------------------------------------------
case "$EXPECT" in
  serialized)
    [ "$kpi_1" = "$ledger_1" ] || fail \
      "LOST COLLECTION: the confirmation succeeded but the period records $kpi_1 against a ledger of $ledger_1. confirm_payment() wrote kpi_targets without holding the period lock replace_kpi_targets() holds"
    [ "$kpi_2" = "$ledger_2" ] || fail \
      "UNREVERSED CREDIT: the void succeeded but the period still records $kpi_2 against a ledger of $ledger_2. void_payment() wrote kpi_targets without holding the period lock"
    echo "  kpi period lock OK: serialized both ways — credit $kpi_1 = $ledger_1, debit $kpi_2 = $ledger_2"
    ;;
  lost)
    if [ "$kpi_1" = "$ledger_1" ] && [ "$kpi_2" = "$ledger_2" ]; then
      fail "the lock-free control did NOT lose anything (credit $kpi_1 = $ledger_1, debit $kpi_2 = $ledger_2), so this gate proves nothing about the fix. Re-read the barriers above before changing the expectation"
    fi
    [ "$kpi_1" = "0.00" ] || fail \
      "the lock-free control was expected to lose the whole collection (actual 0.00 against a ledger of $ledger_1), but recorded $kpi_1 — the interleaving is not the one this gate describes"
    [ "$kpi_2" = "$AMOUNT" ] || fail \
      "the lock-free control was expected to keep the voided credit ($AMOUNT against a ledger of 0.00), but recorded $kpi_2"
    echo "  control OK: without the period lock the credit was lost ($kpi_1 vs $ledger_1) and the void was not applied ($kpi_2 vs $ledger_2)"
    ;;
esac
