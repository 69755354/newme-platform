#!/usr/bin/env bash
# ============================================================================
# The cash predicate, measured against the row that makes it matter (R5)
# ============================================================================
# Every derived total in this database counts a payment as cash when
# `confirmed = true and voided_at is null`. Seven read paths in the application
# counted `confirmed` alone, and one of them — src/app/api/dashboard/payment-
# tracker/route.ts — did not even SELECT voided_at, so no JavaScript there could
# have been right.
#
# "Those two predicates differ" is a claim about a row, not about source code, and
# it is only a defect if the row is reachable. This gate settles that in the
# database rather than by reading the routes:
#
#   EXPECT=compat  the compatibility window this release ships in. A payment is
#                  confirmed and then reversed through the routines, so it sits in
#                  the ordinary reversed state. An end-user session then re-confirms
#                  it with a direct UPDATE — permitted here, because
#                  money_direct_write_is_blocked() is false while the mode is
#                  compat, and the statement never touches the void columns the
#                  guard protects unconditionally. The row is now
#                  `confirmed = true AND voided_at is not null`, and the two
#                  predicates disagree by exactly its amount. Measured from a FRESH
#                  connection, so the divergence is committed state and not one
#                  session's snapshot.
#
#   EXPECT=strict  the posture the contract phase installs. The same statement from
#                  the same session is refused with 42501, the row does not move,
#                  and both predicates return the same total.
#
# Both directions also measure four things the mode does not change, because they
# are what bound the finding:
#
#   the reversal is one-way   a session may re-confirm a reversal; it may never
#                             erase one. `update payments set voided_at = null` is
#                             refused with 42501 in BOTH modes, before the mode is
#                             consulted at all. So the contradictory row can only be
#                             built by re-confirming, never by un-voiding, and the
#                             divergence is one-directional.
#   the loop with no exit     on the ordinary reversed row, allocate_payment()
#                             answers 22023 'payment must be confirmed before
#                             allocation' and confirm_payment() answers 22023 'a
#                             voided payment cannot be confirmed'. An operator sent
#                             from one to the other has nowhere to go. This is the
#                             behaviour the route prechecks now report up front
#                             instead of discovering a round-trip later:
#                             src/app/api/payments/[id]/{confirm,allocate}/route.ts.
#   reentry                   each refusal is repeated, and the second attempt must
#                             report the identical SQLSTATE and message and leave
#                             the row identical. A refusal that drifts on retry is
#                             one no client can be written against.
#   interruption              the divergence-creating write is also run inside a
#                             transaction that is rolled back, and the predicates
#                             must agree again afterwards. What diverges is
#                             committed state; an interrupted write leaves nothing.
#
# The concurrency dimension is measured here too, and it decides whether the compat
# window can leak past the release: while that UPDATE is in flight it holds
# money_release_mode_lock_key() in SHARE mode, which is the lock
# 17_concurrency_mode_flip.sh and 18_concurrency_mode_setter.sh prove the flip takes
# EXCLUSIVELY. Asserted by identity, not by count: re-acquiring the flip key inside
# the same transaction must add no pg_locks row, which is only true if the lock the
# write already holds IS that key. A refcount bump is invisible in pg_locks, so this
# is the one form of the question that has an observable answer.
#
# What this gate does NOT claim
# -----------------------------
# It does not prove the routes were fixed — a database cannot see JavaScript. It
# proves the divergence was real, reachable and measurable, and that it is
# unreachable once the release is strict. The equivalence of the JavaScript
# predicate to the SQL one is executed in
# tests/security/api-cache-money-boundary.test.mjs, which runs countsAsCash() over
# the same row shapes this gate stages, the contradictory one included.
#
# Footprint: one payment (d5d5…) dated 2019-10 — a period no fixture and no
# assertion uses, and confirm_payment()/void_payment() only UPDATE kpi_targets, so a
# period with no target rows gains none — on fixture contract C4, which has no
# projects row and whose first_payment_status is derived from ALLOCATIONS (this
# payment is never allocated). The payment is removed at the end, the removal is
# verified, C4's first_payment_status is required back unchanged, and the release
# mode is restored to whatever the gate was invoked under.
#
# Requires: psql on PATH, PG* pointing at the throwaway replay database. Invoked by
# scripts/replay-migrations.sh. EXPECT is mandatory and has no default, because
# defaulting it is how a control run silently asserts the other branch's claim.
# ============================================================================
set -euo pipefail

: "${EXPECT:?EXPECT must be 'compat' (the divergence is reachable) or 'strict' (the write that creates it is refused)}"
case "$EXPECT" in
  compat|strict) ;;
  *) echo "predicate gate: EXPECT must be 'compat' or 'strict', got '$EXPECT'" >&2; exit 1 ;;
esac

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

# Fixed values, no random(): the assertions and the cleanup name their rows.
CONTRACT='c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4'   # 05_seed_behaviour_fixtures.sql, no projects row
SALES='cccccccc-cccc-cccc-cccc-cccccccccccc'      # C4.sales_id — the identity policy_payments_update_sales admits
FINANCE='ffffffff-ffff-ffff-ffff-ffffffffffff'    # replay-finance, role 'finance', active
PAYMENT='d5d5d5d5-d5d5-d5d5-d5d5-d5d5d5d5d5d5'
PLAN='94444444-4444-4444-4444-444444444444'       # C4's only installment plan, seq 1
PERIOD='2019-10'                                  # used by no fixture and no assertion; 19_ owns the month after
PAY_DATE='2019-10-15'
AMOUNT='7654.00'
REQUEST_KEY='d5d5d5d5-0000-4000-8000-00000000d5d5'   # payments.request_key is a uuid; 16_ owns a different one
NOTES_PROBE='replay 21 in-flight probe'

work_dir="$(mktemp -d)"

fail() {
  echo "predicate gate failed: $*" >&2
  exit 1
}

cleanup() {
  local status=$?
  rm -rf "$work_dir"
  return $status
}
trap cleanup EXIT

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"

# One scalar, as the harness role, from a connection of its own — so every number
# below is committed state rather than some open transaction's snapshot.
q() {
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "$1" | tr -d '[:space:]'
}

# ---------------------------------------------------------------------------
# An attempt whose outcome is a value rather than an exit status.
#
# The project idiom (17_concurrency_mode_flip.sh, session C): VERBOSITY verbose so
# the SQLSTATE is in the log, ON_ERROR_STOP=1 so a refused statement ends the
# session before its COMMIT is read, and the ERROR line parsed out. A refusal
# therefore rolls its whole transaction back on disconnect — which is what makes
# "the refused attempt changed no row" a fact this gate can check afterwards rather
# than a hope.
#
# Two roles. `sales` sets the end-user claims and SET LOCAL ROLE authenticated, so
# money_write_is_direct() is true and the write is judged as a direct write.
# `server` leaves current_user as the harness role, which is how the application
# reaches the routines: the direct-write guards stand down and the routine's own
# validation is what answers. Both carry the claim shape GoTrue issues, because
# void_payment() resolves its actor from the session.
# ---------------------------------------------------------------------------
attempt() {
  local role="$1" who="$2" sql="$3" log="$work_dir/attempt.log"
  {
    echo '\set VERBOSITY verbose'
    echo "set application_name = 'replay_predicate_$role';"
    echo 'begin;'
    echo "select set_config('request.jwt.claims',
                            json_build_object('sub', '$who', 'role', 'authenticated',
                                              'iat', floor(extract(epoch from now()))::bigint)::text,
                            true);"
    [ "$role" = sales ] && echo 'set local role authenticated;'
    echo "$sql"
    echo 'commit;'
  } >"$work_dir/attempt.sql"

  : >"$log"
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -f "$work_dir/attempt.sql" >"$log" 2>&1 || true

  local err
  err="$(sed -n 's/.*ERROR:  \([0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]\): \(.*\)$/err|\1|\2/p' "$log" | head -1)"
  if [ -n "$err" ]; then
    printf '%s\n' "$err"
  else
    # No ERROR line: the transaction committed. The routines return json, so their
    # answer is carried out on one line for the caller to assert on.
    printf 'ok|%s\n' "$(tr -d '\r' <"$log" | tr '\n' ' ')"
  fi
}

as_sales()  { attempt sales  "$SALES"   "$1"; }
as_server() { attempt server "$FINANCE" "$1"; }

expect_refusal() {
  local got="$1" state="$2" needle="$3" what="$4"
  case "$got" in
    "err|$state|"*) ;;
    *) fail "$what: expected SQLSTATE $state, got '$got'" ;;
  esac
  case "$got" in
    *"$needle"*) ;;
    *) fail "$what: refused with $state but not for the stated reason — expected a message containing '$needle', got '$got'" ;;
  esac
}

expect_ok() {
  local got="$1" what="$2"
  case "$got" in
    ok*) ;;
    *) fail "$what: expected to succeed, got '$got'" ;;
  esac
}

# ---------------------------------------------------------------------------
# Preconditions, asserted rather than assumed.
# ---------------------------------------------------------------------------
for sig in 'public.confirm_payment(uuid, uuid)' \
           'public.void_payment(uuid, text)' \
           'public.allocate_payment(uuid, jsonb, uuid)' \
           'public.money_direct_write_mode()' \
           'public.money_set_direct_write_mode(text, text)' \
           'public.money_direct_write_is_blocked()' \
           'public.money_release_mode_lock_key()' \
           'public.guard_payments_write()'; do
  [ "$(q "select count(*) from pg_proc where oid = to_regprocedure('$sig')")" = "1" ] \
    || fail "$sig is not present in this database"
done
[ "$(q "select count(*) from public.contracts where id = '$CONTRACT' and sales_id = '$SALES'")" = "1" ] \
  || fail "fixture contract $CONTRACT is missing or is not owned by $SALES"
[ "$(q "select count(*) from public.projects where contract_id = '$CONTRACT'")" = "0" ] \
  || fail "fixture contract $CONTRACT has acquired a projects row; this gate assumes it has none"
# The allocation attempt below has to be refused for the RIGHT reason.
# allocate_payment() validates the payload shape before it looks at the payment
# (measured: an empty array answers 22023 'allocations must be a non-empty array'),
# so the attempt carries a real plan and a real amount and is refused on the
# payment's state — which is the claim.
[ "$(q "select count(*) from public.installment_plans
          where id = '$PLAN' and contract_id = '$CONTRACT'")" = "1" ] \
  || fail "fixture installment plan $PLAN is missing or does not belong to $CONTRACT"
for who in "$SALES" "$FINANCE"; do
  [ "$(q "select count(*) from public.profiles where id = '$who' and coalesce(is_active, false)")" = "1" ] \
    || fail "fixture profile $who is missing or not active"
done
[ "$(q "select count(*) from public.kpi_targets where period = '$PERIOD'")" = "0" ] \
  || fail "period $PERIOD already has target rows; this gate stages a payment there so it moves no fixture's KPI"
# The trigger has to be attached, not merely defined: a gate that measures a
# refusal which cannot fire is measuring a schema nobody deployed.
[ "$(q "select count(*) from pg_trigger where tgrelid = 'public.payments'::regclass
          and tgname = 'trg_guard_payments_write' and not tgisinternal")" = "1" ] \
  || fail "trg_guard_payments_write is not attached to public.payments"
# And `authenticated` has to be able to reach the row at all, or a refusal below
# could be a missing grant wearing the guard's SQLSTATE.
[ "$(q "select has_table_privilege('authenticated', 'public.payments', 'UPDATE')::text")" = "true" ] \
  || fail "authenticated does not hold UPDATE on public.payments, so this gate cannot stage a direct write"

entry_mode="$(q "select public.money_direct_write_mode()")"
case "$entry_mode" in
  compat|strict) ;;
  *) fail "the release mode on entry is '$entry_mode', which is neither compat nor strict" ;;
esac
FP_ON_ENTRY="$(q "select coalesce(first_payment_status, '<null>') from public.contracts where id = '$CONTRACT'")"
ALLOCATED_ON_ENTRY="$(q "select allocated_amount from public.installment_plans where id = '$PLAN'")"

# ---------------------------------------------------------------------------
# Two predicates over the same rows. `ledger` is what every derived total in the
# database counts; `loose` is what the routes counted. Both are scoped to this
# gate's period, so no fixture's money is in either number.
# ---------------------------------------------------------------------------
ledger_of() {
  q "select coalesce(sum(amount), 0.00) from public.payments
      where to_char(payment_date, 'YYYY-MM') = '$PERIOD' and confirmed = true and voided_at is null"
}
loose_of() {
  q "select coalesce(sum(amount), 0.00) from public.payments
      where to_char(payment_date, 'YYYY-MM') = '$PERIOD' and confirmed = true"
}
row_state() {
  q "select coalesce(confirmed, false)::text || '/' ||
            case when voided_at is null then 'live' else 'voided' end
       from public.payments where id = '$PAYMENT'"
}

# ---------------------------------------------------------------------------
# Stage the row: recorded, confirmed, then reversed — all through the routines, so
# the starting point is a reversal the application itself produced.
# ---------------------------------------------------------------------------
cat >"$work_dir/setup.sql" <<SQL
delete from public.payments where id = '$PAYMENT';
insert into public.payments (id, contract_id, amount, payment_date, confirmed, created_by, request_key)
values ('$PAYMENT', '$CONTRACT', $AMOUNT, '$PAY_DATE', false, '$SALES', '$REQUEST_KEY');
SQL
psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
  -f "$work_dir/setup.sql" >"$work_dir/setup.log" 2>&1 \
  || { cat "$work_dir/setup.log" >&2; fail "could not stage the payment"; }

got="$(as_server "select public.confirm_payment('$PAYMENT', '$FINANCE');")"
expect_ok "$got" "confirming the staged payment"
case "$got" in *'"success"'*) ;; *) fail "confirm_payment did not report success: $got" ;; esac
[ "$(row_state)" = "true/live" ] || fail "the payment is $(row_state) after confirm_payment, not true/live"
[ "$(ledger_of)" = "$AMOUNT" ] || fail "the ledger does not count the confirmed payment (got $(ledger_of))"

got="$(as_server "select public.void_payment('$PAYMENT', 'replay 21: predicate divergence gate');")"
expect_ok "$got" "reversing the staged payment"
case "$got" in *'"success"'*) ;; *) fail "void_payment did not report success: $got" ;; esac
[ "$(row_state)" = "false/voided" ] || fail "the payment is $(row_state) after void_payment, not false/voided"

# The ordinary reversed state: the two predicates AGREE, because void_payment()
# clears `confirmed` on its way out. This is why the divergence needs a direct write
# to exist at all — and why it was invisible to any test that only ever reached the
# rows through the routines.
[ "$(ledger_of)" = "0.00" ] || fail "the ledger still counts the reversed payment (got $(ledger_of))"
[ "$(loose_of)" = "0.00" ] \
  || fail "the loose predicate already diverges after a routine-only reversal (got $(loose_of)); void_payment() no longer clears confirmed, so this gate is measuring something else"
echo "  staged: $AMOUNT recorded, confirmed and reversed through the routines (row is $(row_state), both predicates 0.00)"

# The end-user session has to be able to see the row, or the write below could
# report success having matched nothing.
got="$(as_sales "select 'visible=' || count(*) from public.payments where id = '$PAYMENT';")"
case "$got" in *visible=1*) ;; *) fail "the owning salesperson cannot see the staged payment through RLS: $got" ;; esac

# ===========================================================================
# The loop with no exit, and its reentry. Mode-independent: these are the
# routines' own refusals, and they are what the route prechecks now mirror.
# ===========================================================================
ALLOC_PAYLOAD="[{\"plan_id\": \"$PLAN\", \"amount\": \"1.00\"}]"

for pass in first second; do
  got="$(as_server "select public.allocate_payment('$PAYMENT', '$ALLOC_PAYLOAD'::jsonb, '$FINANCE');")"
  expect_refusal "$got" "22023" "payment must be confirmed before allocation" \
    "allocating a reversed payment ($pass attempt)"
  if [ "$pass" = first ]; then alloc_first="$got"; else alloc_second="$got"; fi

  got="$(as_server "select public.confirm_payment('$PAYMENT', '$FINANCE');")"
  expect_refusal "$got" "22023" "a voided payment cannot be confirmed" \
    "confirming a reversed payment ($pass attempt)"
  if [ "$pass" = first ]; then confirm_first="$got"; else confirm_second="$got"; fi

  [ "$(row_state)" = "false/voided" ] \
    || fail "a refused settlement attempt changed the row to $(row_state) ($pass attempt)"
  # And it moved nothing on the other side of the allocation either.
  [ "$(q "select count(*) from public.payment_allocations where payment_id = '$PAYMENT'")" = "0" ] \
    || fail "a refused allocation left allocation rows behind ($pass attempt)"
  [ "$(q "select allocated_amount from public.installment_plans where id = '$PLAN'")" = "$ALLOCATED_ON_ENTRY" ] \
    || fail "a refused allocation moved plan $PLAN to $(q "select allocated_amount from public.installment_plans where id = '$PLAN'") from $ALLOCATED_ON_ENTRY ($pass attempt)"
done
[ "$alloc_second" = "$alloc_first" ] \
  || fail "the second allocation attempt reported '$alloc_second' but the first reported '$alloc_first'; the refusal is not idempotent"
[ "$confirm_second" = "$confirm_first" ] \
  || fail "the second confirmation attempt reported '$confirm_second' but the first reported '$confirm_first'; the refusal is not idempotent"
echo "  the loop with no exit: allocate says 'must be confirmed', confirm says 'cannot confirm a voided payment' — twice each, identically, with no row change"

# The reversal is one-way, in both modes, and refused before the mode is consulted.
# This is what makes the contradictory row buildable in only one direction.
got="$(as_sales "update public.payments set voided_at = null where id = '$PAYMENT';")"
expect_refusal "$got" "42501" "a payment is voided through void_payment()" \
  "un-voiding a reversed payment from an end-user session"
[ "$(row_state)" = "false/voided" ] || fail "the refused un-void still changed the row to $(row_state)"
echo "  a session cannot erase a reversal (42501), whatever the mode"

# ---------------------------------------------------------------------------
# The posture under test.
# ---------------------------------------------------------------------------
psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
  -c "select public.money_set_direct_write_mode('$EXPECT',
        'supabase/replay/21_payment_predicate_divergence.sh: staging the $EXPECT posture')" \
  >"$work_dir/mode.log" 2>&1 \
  || { cat "$work_dir/mode.log" >&2; fail "could not set the release mode to $EXPECT"; }
[ "$(q "select public.money_direct_write_mode()")" = "$EXPECT" ] \
  || fail "the mode is not '$EXPECT' after staging it"

# ===========================================================================
# Interruption, and the lock the write holds while it is in flight.
#
# One transaction: a direct write, three questions asked from inside it, then
# ROLLBACK. The write has to be one the guard PERMITS in the mode under test, or
# psql would stop at the refusal and the lock questions would never be asked — and
# the lock is the point here, not the refusal. So compat uses the
# divergence-creating write itself and strict uses a notes-only write, which the
# guard permits in both modes: the row is unconfirmed, so the strict branch reaches
# its final check and `notes` is in neither immutability list (20260817000000 §5).
# money_direct_write_is_blocked() is called for every direct write, not only for the
# ones it goes on to refuse, so both are equally good probes of the lock.
# ===========================================================================
if [ "$EXPECT" = compat ]; then
  probe_write="update public.payments set confirmed = true where id = '$PAYMENT';"
  probe_effect="confirmed = true"
else
  probe_write="update public.payments set notes = '$NOTES_PROBE' where id = '$PAYMENT';"
  probe_effect="notes = '$NOTES_PROBE'"
fi

cat >"$work_dir/inflight.sql" <<SQL
\\set VERBOSITY verbose
set application_name = 'replay_predicate_inflight';
begin;
select set_config('request.jwt.claims',
                  json_build_object('sub', '$SALES', 'role', 'authenticated',
                                    'iat', floor(extract(epoch from now()))::bigint)::text,
                  true);
set local role authenticated;
select 'advisory_before=' || count(*) from pg_locks
 where locktype = 'advisory' and pid = pg_backend_pid();
$probe_write
select 'effect_in_tx=' || count(*) from public.payments
 where id = '$PAYMENT' and $probe_effect;
select 'advisory_after=' || count(*) from pg_locks
 where locktype = 'advisory' and pid = pg_backend_pid() and mode = 'ShareLock' and granted;
-- Identity, not count: re-taking the flip key must add no row, which is only true
-- if the lock already held IS that key.
select pg_advisory_xact_lock_shared(public.money_release_mode_lock_key());
select 'advisory_retake=' || count(*) from pg_locks
 where locktype = 'advisory' and pid = pg_backend_pid() and mode = 'ShareLock' and granted;
rollback;
SQL
psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
  -f "$work_dir/inflight.sql" >"$work_dir/inflight.log" 2>&1 \
  || { cat "$work_dir/inflight.log" >&2; fail "the in-flight probe did not run to completion"; }

pick() { sed -n "s/^$1=//p" "$work_dir/inflight.log" | head -1 | tr -d '[:space:]'; }
adv_before="$(pick advisory_before)"
adv_effect="$(pick effect_in_tx)"
adv_after="$(pick advisory_after)"
adv_retake="$(pick advisory_retake)"

[ "$adv_before" = "0" ] \
  || fail "the probe session already held $adv_before advisory lock(s) before writing, so the lock measured next is not the write's"
[ "$adv_effect" = "1" ] \
  || fail "the in-flight write did not take effect inside its own transaction (effect rows = $adv_effect)"
[ "$adv_after" = "1" ] \
  || fail "a direct money write left $adv_after granted advisory share lock(s); money_direct_write_is_blocked() takes exactly one — the flip key"
[ "$adv_retake" = "1" ] \
  || fail "re-taking money_release_mode_lock_key() added a lock row (now $adv_retake), so the lock the write holds is a DIFFERENT key and a mode flip would not wait for it"

# The transaction was rolled back, so nothing it did may be visible.
[ "$(row_state)" = "false/voided" ] \
  || fail "the rolled-back transaction left the row at $(row_state); an interrupted direct write is not supposed to survive"
[ "$(ledger_of)" = "$(loose_of)" ] \
  || fail "the predicates disagree after a rolled-back write (ledger $(ledger_of), loose $(loose_of)); the divergence is not committed state"
echo "  in flight: the write took effect in its own transaction, held exactly one advisory share lock, and that lock is money_release_mode_lock_key(); the rollback left nothing"

# ===========================================================================
# The write itself, committed this time.
# ===========================================================================
divergence_write="$(as_sales "update public.payments set confirmed = true where id = '$PAYMENT';")"

# Read after write, from a connection that has never seen this row: the numbers
# below are committed state, not the writing session's snapshot.
state_after="$(row_state)"
ledger_after="$(ledger_of)"
loose_after="$(loose_of)"
echo "  after the direct re-confirmation ($EXPECT): result=${divergence_write%%|*} row=$state_after ledger=$ledger_after loose=$loose_after"

# ---------------------------------------------------------------------------
# Cleanup before the verdict, so a FAILING gate still leaves the database in the
# state the fixtures created and the posture it was found in. The DELETE runs as the
# harness role: a direct DELETE is refused outright ('payments are not deleted;
# reverse the payment through void_payment() instead'), which is 20260817000000 §5
# working as intended.
# ---------------------------------------------------------------------------
cat >"$work_dir/teardown.sql" <<SQL
select public.money_set_direct_write_mode('$entry_mode',
  'supabase/replay/21_payment_predicate_divergence.sh: restoring the posture the gate was invoked under');
delete from public.payments where id = '$PAYMENT';
SQL
psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
  -f "$work_dir/teardown.sql" >"$work_dir/teardown.log" 2>&1 \
  || { cat "$work_dir/teardown.log" >&2; fail "could not remove the staged payment and restore the posture"; }

[ "$(q "select count(*) from public.payments where id = '$PAYMENT'")" = "0" ] \
  || fail "the staged payment was left behind"
mode_on_exit="$(q "select public.money_direct_write_mode()")"
[ "$mode_on_exit" = "$entry_mode" ] \
  || fail "the release mode was left at '$mode_on_exit' instead of the '$entry_mode' this gate found"
[ "$(q "select count(*) from public.kpi_targets where period = '$PERIOD'")" = "0" ] \
  || fail "this gate created kpi_targets rows for $PERIOD"
[ "$(q "select count(*) from public.projects where contract_id = '$CONTRACT'")" = "0" ] \
  || fail "this gate created a projects row for $CONTRACT"
fp_on_exit="$(q "select coalesce(first_payment_status, '<null>') from public.contracts where id = '$CONTRACT'")"
[ "$fp_on_exit" = "$FP_ON_ENTRY" ] \
  || fail "contract $CONTRACT left this gate with first_payment_status=$fp_on_exit, not the $FP_ON_ENTRY it arrived with"
allocated_on_exit="$(q "select allocated_amount from public.installment_plans where id = '$PLAN'")"
[ "$allocated_on_exit" = "$ALLOCATED_ON_ENTRY" ] \
  || fail "plan $PLAN left this gate allocating $allocated_on_exit, not the $ALLOCATED_ON_ENTRY it arrived with"

# ===========================================================================
# The verdict.
# ===========================================================================
case "$EXPECT" in
  compat)
    case "$divergence_write" in
      ok*) ;;
      *) fail "the compatibility window refused the direct re-confirmation ('$divergence_write'), so this run reproduces nothing. If the guard now blocks it in compat too, the finding is closed in the database and this gate has to say so rather than assert a reachable row" ;;
    esac
    [ "$state_after" = "true/voided" ] \
      || fail "the direct write left the row at $state_after, not the contradictory true/voided state this gate is about"
    [ "$ledger_after" = "0.00" ] \
      || fail "the ledger predicate counted the re-confirmed reversal ($ledger_after); it counts confirmed AND un-voided, so it must still be 0.00"
    [ "$loose_after" = "$AMOUNT" ] \
      || fail "the loose predicate returned $loose_after instead of $AMOUNT, so it is not the predicate the routes used"
    [ "$ledger_after" != "$loose_after" ] \
      || fail "the two predicates agree ($ledger_after), so nothing was reproduced"
    echo "  DIVERGENCE REPRODUCED: one end-user UPDATE inside the compatibility window makes 'confirmed' report $loose_after where the ledger reports $ledger_after — a difference of exactly the reversed payment's $AMOUNT, committed and visible to a fresh connection"
    ;;
  strict)
    expect_refusal "$divergence_write" "42501" \
      "payment confirmation, amount and linkage change through confirm_payment() and allocate_payment()" \
      "re-confirming a reversed payment under the strict posture"
    [ "$state_after" = "false/voided" ] \
      || fail "the strict posture refused the write but the row is $state_after; a refusal that moves the row is not a refusal"
    { [ "$ledger_after" = "0.00" ] && [ "$loose_after" = "0.00" ]; } \
      || fail "the predicates are not both 0.00 under strict (ledger $ledger_after, loose $loose_after), so the contradictory row is reachable after all"
    echo "  BOUNDED: under the strict posture the same statement is refused with 42501, the row does not move, and both predicates report $ledger_after"
    ;;
esac
