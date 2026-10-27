#!/usr/bin/env bash
# ============================================================================
# Two-session gate for the expand/contract flip
# ============================================================================
# Round-4 finding C4-3: "serialize compat writes against the phase flip with
# database locks, and wait for in-flight old writes to drain."
#
# The flip used to be a bare `insert … on conflict do update` on
# public.money_release_mode with no lock anywhere, and the guards read the mode
# with no lock either. Sequentially that looks correct — the row changes, the next
# write is refused — and every single-session assertion in this harness passed.
# What one session cannot see is the interval:
#
#   the operator applies 20260818000000, it commits 'strict', the operator now
#   believes direct end-user money writes have stopped — while a write from the
#   PREVIOUS release, admitted under 'compat', is still uncommitted and goes on to
#   commit afterwards.
#
# That is the whole finding, and it is a claim about two overlapping transactions,
# so only two sessions can settle it.
#
#   EXPECT=serialized   (the release, with the shared/exclusive lock pair)
#       the flip BLOCKS on the in-flight compat write until it commits. While it
#       is blocked, a third session — which can only see committed rows — still
#       reads 'compat'. The old write finishes first, and only then does 'strict'
#       become the committed truth.
#
#   EXPECT=torn         (the same database with the lock removed from the guard)
#       the flip does not block at all. It commits 'strict' while the compat
#       write is still open, and that write then commits underneath it. This is
#       the defect, reproduced rather than described.
#
# The control is a mutation of public.money_direct_write_is_blocked() in this
# throwaway replay database, never a change to a file: the definition is captured
# with pg_get_functiondef() before the mutation and restored from that capture
# afterwards, and the gate fails if the restored definition is not byte-identical
# to the captured one. A control that cannot prove it put the guard back is a
# control that may have measured the next gate for it.
#
# Interleaving discipline, same as 15_concurrency_two_session.sh and
# 16_concurrency_request_key.sh: session A is driven statement by statement over
# an anonymous pipe, and every barrier is a fact read out of the database rather
# than a sleep.
#
#   1. Set the mode to 'compat' — the posture the previous release runs under and
#      the state 20260814000000 seeds. The mode found on entry is restored at the
#      end, so this gate leaves the database as it found it.
#   2. A: begin, become an end-user session (request.jwt.claims + role
#      authenticated), insert a contract directly — exactly the write the previous
#      release performs and the contract phase exists to stop — then take an
#      advisory lock as a done-marker. A is now holding an uncommitted money row.
#   3. Poll pg_locks until that marker is granted: proof A's write went through
#      and has not committed.
#   4. B: run supabase/migrations/20260818000000_money_direct_write_contract_phase.sql,
#      the real artifact, as a whole transaction in the background.
#        EXPECT=serialized — poll pg_locks until B is recorded as WAITING on the
#                            advisory lock, then read the mode from a third
#                            session and require it to still be 'compat'.
#        EXPECT=torn       — poll a third session until 'strict' is COMMITTED
#                            while A is still open, which is the defect.
#   5. Only then does A commit. Whatever the mode did, A's write must succeed:
#      a write admitted under 'compat' is not supposed to fail, and if it did the
#      flip would be breaking the compatibility window instead of ending it.
#   6. EXPECT=serialized only: with A gone, stage the drain-timeout half. A second
#      compat write is opened and held, and the flip is re-run with a 2s
#      lock_timeout. It must fail with 55P03 rather than hang or proceed, because
#      an operator whose flip cannot drain has to be told, not parked.
#
# Every barrier not reached inside the timeout FAILS the run with both session
# logs. A gate that cannot stage the race must not report on it.
#
# Everything is synthetic: one lead and one contract of this gate's own, on fixed
# UUIDs, removed again at the end, and the release mode restored to whatever it
# was on entry. Requires psql on PATH and PG* pointing at the throwaway replay
# database. Invoked by scripts/replay-migrations.sh; EXPECT is mandatory and has
# no default, because defaulting it is how a control run silently asserts the
# branch claim.
# ============================================================================
set -euo pipefail

: "${EXPECT:?EXPECT must be 'serialized' (with the lock) or 'torn' (guard mutated to drop it)}"
case "$EXPECT" in
  serialized|torn) ;;
  *) echo "mode-flip gate: EXPECT must be 'serialized' or 'torn', got '$EXPECT'" >&2; exit 1 ;;
esac

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_PHASE="${CONTRACT_PHASE:-$SCRIPT_DIR/../migrations/20260818000000_money_direct_write_contract_phase.sql}"

# Fixed UUIDs, no random(): the verdict and the cleanup reference them by value.
ACTOR='cccccccc-cccc-cccc-cccc-cccccccccccc'   # 05_seed_behaviour_fixtures.sql, sales, active
LEAD='17171717-1717-1717-1717-171717171717'    # this gate's own lead
CONTRACT_NO='REPLAY-FLIP-COMPAT-1'
LEAD_B='17171717-1717-1717-1717-171717171718'  # the drain-timeout half's lead
# Session C gets a lead of its own rather than sharing the drain half's. Measured:
# with a mutated guard that accepts C's write, a shared lead makes C's row collide
# with the drain half's insert on idx_contracts_one_active_per_lead, the drain
# staging fails first, and the gate reports "could not stage the drain-timeout half"
# instead of the defect it had already measured. A gate that hides its own finding
# behind a later staging error is worse than one that fails plainly.
LEAD_C='17171717-1717-1717-1717-171717171719'
CONTRACT_NO_B='REPLAY-FLIP-COMPAT-2'
CONTRACT_NO_C='REPLAY-FLIP-DURING-1'           # the write that STARTS during the flip
MARK_HI=918273                                 # advisory done-marker for A
MARK_LO=648                                    # 645/646 belong to the other two gates
BARRIER_TIMEOUT="${BARRIER_TIMEOUT:-90}"
BLOCK_TIMEOUT="${BLOCK_TIMEOUT:-20}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-2s}"
b_blocked=0
mode_while_blocked='unread'
c_waited=0
c_rows='unread'
c_refused=''
entry_mode=''
guard_def=''
mutated=0

work_dir="$(mktemp -d)"
out_a="$work_dir/session_a.log"
out_b="$work_dir/session_b.log"
out_c="$work_dir/session_c.log"
out_d="$work_dir/session_d.log"
out_e="$work_dir/session_e_drain_flip.log"

PSQL_Q=(psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1)

fail() {
  echo "mode-flip gate failed: $*" >&2
  exit 1
}

q() { "${PSQL_Q[@]}" -c "$1" | tr -d '[:space:]'; }
# Same, keeping internal whitespace: pg_get_functiondef must survive a round trip.
q_raw() { "${PSQL_Q[@]}" -c "$1"; }

dump_sessions() {
  for log in "$out_a" "$out_b" "$out_c" "$out_d" "$out_e"; do
    [ -f "$log" ] || continue
    echo "--- $(basename "$log") ---" >&2
    cat "$log" >&2
  done
}

restore_guard() {
  [ "$mutated" = "1" ] || return 0
  [ -s "$work_dir/guard.sql" ] || { echo "mode-flip gate: the captured guard definition is missing; the mutation cannot be undone" >&2; return 1; }
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/guard.sql" >"$work_dir/restore.log" 2>&1 || {
    cat "$work_dir/restore.log" >&2
    return 1
  }
  mutated=0
  local now
  now="$(q_raw "select pg_get_functiondef('public.money_direct_write_is_blocked()'::regprocedure)")"
  [ "$now" = "$guard_def" ] || {
    echo "mode-flip gate: the guard was restored but is not byte-identical to the definition captured on entry" >&2
    return 1
  }
  return 0
}

cleanup() {
  local status=$?
  if [ -n "${A_IN:-}" ]; then
    eval "exec ${A_IN}>&-" 2>/dev/null || true
  fi
  [ -n "${A_PID:-}" ] && wait "$A_PID" 2>/dev/null || true
  [ -n "${C_PID:-}" ] && wait "$C_PID" 2>/dev/null || true
  if [ -n "${D_IN:-}" ]; then
    eval "exec ${D_IN}>&-" 2>/dev/null || true
  fi
  [ -n "${D_PID:-}" ] && wait "$D_PID" 2>/dev/null || true
  [ -n "${B_PID:-}" ] && wait "$B_PID" 2>/dev/null || true
  restore_guard || status=1
  rm -rf "$work_dir"
  return $status
}
trap cleanup EXIT

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"
[ -f "$CONTRACT_PHASE" ] || fail "the contract phase migration is not at $CONTRACT_PHASE; this gate runs the real artifact, not a copy of it"

# ---------------------------------------------------------------------------
# Preconditions. What is being measured has to be present before it is measured,
# and the mutation has to be undoable before it is made.
# ---------------------------------------------------------------------------
[ "$(q "select count(*) from public.profiles
        where id = '$ACTOR' and coalesce(is_active, false)")" = "1" ] \
  || fail "fixture actor $ACTOR is missing or not active"
[ "$(q "select count(*) from public.money_release_mode where id = 'only'")" = "1" ] \
  || fail "public.money_release_mode has no 'only' row, so there is no posture to flip"
[ "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'money_release_mode_lock_key'")" = "1" ] \
  || fail "public.money_release_mode_lock_key() does not exist, so neither half of the flip lock can be taken"

# The six mode-controlled guards, by (trigger, table) pair — the same set
# recontract_money_direct_write_contract_phase.sql and the manifest posture
# predicates name. A missing one would make "the write was accepted" say nothing
# about the mode.
guards="$(q "select count(*) from pg_trigger g
               join pg_class c on c.oid = g.tgrelid
               join pg_namespace n on n.oid = c.relnamespace
               join pg_proc p on p.oid = g.tgfoid
              where not g.tgisinternal and g.tgenabled = 'O'
                and n.nspname = 'public' and p.prokind = 'f'
                and pg_get_functiondef(p.oid) like '%money_direct_write_is_blocked%'")"
[ "$guards" = "6" ] || fail "expected 6 enabled mode-controlled guard triggers, found $guards"

# The marker key and the flip key cannot collide — the two-int form is recorded
# with objsubid 2 and the bigint form with objsubid 1 — but the gate says so out
# loud rather than relying on the reader knowing it.
[ "$(q "select count(*) from pg_locks
         where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO")" = "0" ] \
  || fail "the done-marker key ($MARK_HI, $MARK_LO) is already locked by someone else"

FLIP_KEY="$(q "select public.money_release_mode_lock_key()")"
[ -n "$FLIP_KEY" ] || fail "could not read the flip lock key"

guard_def="$(q_raw "select pg_get_functiondef('public.money_direct_write_is_blocked()'::regprocedure)")"
[ -n "$guard_def" ] || fail "could not capture the guard definition, so a mutation could not be undone"
printf '%s\n' "$guard_def" >"$work_dir/guard.sql"

entry_mode="$(q "select direct_write_mode from public.money_release_mode where id = 'only'")"
case "$entry_mode" in
  compat|strict) ;;
  *) fail "the release mode on entry is '$entry_mode', which is neither compat nor strict" ;;
esac

# ---------------------------------------------------------------------------
# The control's mutation: the guard as it was before C4-3 — one stable SQL
# expression, no lock, mode read on the caller's snapshot.
# ---------------------------------------------------------------------------
if [ "$EXPECT" = "torn" ]; then
  cat >"$work_dir/mutate.sql" <<'SQL'
create or replace function public.money_direct_write_is_blocked()
returns boolean
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select public.money_write_is_direct() and public.money_direct_write_mode() = 'strict'
$$;
SQL
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/mutate.sql" >"$work_dir/mutate.log" 2>&1 || {
    cat "$work_dir/mutate.log" >&2
    fail "could not install the un-serialized guard for the control"
  }
  mutated=1
  echo "  control: public.money_direct_write_is_blocked() replaced with the pre-C4-3, lock-free definition"
fi

# ---------------------------------------------------------------------------
# A clean slate for this gate's rows, and the compatibility window.
# ---------------------------------------------------------------------------
cat >"$work_dir/setup.sql" <<SQL
delete from public.contracts where contract_no in ('$CONTRACT_NO', '$CONTRACT_NO_B', '$CONTRACT_NO_C');
delete from public.leads where id in ('$LEAD', '$LEAD_B', '$LEAD_C');
insert into public.leads (id, assigned_to, stage, customer_name, source)
values ('$LEAD', '$ACTOR', 'won', 'Replay mode-flip lead', 'other'),
       ('$LEAD_B', '$ACTOR', 'won', 'Replay mode-flip drain lead', 'other'),
       ('$LEAD_C', '$ACTOR', 'won', 'Replay mode-flip during-flip lead', 'other');
select public.money_set_direct_write_mode('compat',
  'supabase/replay/17_concurrency_mode_flip.sh: staging the compatibility window the previous release writes under');
SQL
if ! psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
     -f "$work_dir/setup.sql" >"$work_dir/setup.log" 2>&1; then
  cat "$work_dir/setup.log" >&2
  fail "could not stage the compatibility window"
fi
[ "$(q "select public.money_direct_write_mode()")" = "compat" ] \
  || fail "the mode is not 'compat' after staging, so there is no compat write to be overtaken"

echo "  staging the previous release's direct contract insert against the contract phase flip"

# ---------------------------------------------------------------------------
# Session A: the previous release's write, held open.
# ---------------------------------------------------------------------------
coproc A_SESSION { psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 >"$out_a" 2>&1; }
A_IN="${A_SESSION[1]}"
A_PID="$A_SESSION_PID"

a_send() { printf '%s\n' "$1" >&"$A_IN" || true; }

# One transaction: an end-user session (request.jwt.claims is what money_actor()
# and the class-28 boundary read), a direct INSERT — the statement the contract
# phase exists to refuse — and the done-marker.
a_send "set application_name = 'replay_flip_a';
        set idle_in_transaction_session_timeout = '${BARRIER_TIMEOUT}s';
        begin;
        select set_config('request.jwt.claims',
                          json_build_object('sub', '$ACTOR', 'role', 'authenticated',
                                            'iat', floor(extract(epoch from now()))::bigint)::text,
                          true);
        set local role authenticated;
        insert into public.contracts (lead_id, sales_id, created_by, contract_no,
                                      contract_amount, party_a_name, status)
        values ('$LEAD', '$ACTOR', '$ACTOR', '$CONTRACT_NO', 1, 'x', 'draft');
        select pg_advisory_xact_lock($MARK_HI, $MARK_LO);"

wait_for() {
  local sql="$1" what="$2" deadline=$((SECONDS + BARRIER_TIMEOUT))
  while :; do
    if [ "$(q "$sql")" != "0" ]; then return 0; fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "mode-flip gate: barrier never reached — $what" >&2
      dump_sessions
      return 1
    fi
    sleep 0.2
  done
}

# Same poll, but a timeout is a measurement rather than a harness failure, and it
# is a short one because a session that is going to block does so immediately.
poll_for() {
  local sql="$1" deadline=$((SECONDS + BLOCK_TIMEOUT))
  while :; do
    if [ "$(q "$sql")" != "0" ]; then return 0; fi
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 0.2
  done
}

# Barrier 1: A has written and is holding it uncommitted.
wait_for "select count(*) from pg_locks
           where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO and granted" \
         "session A never finished its direct insert (it raised, or the session died)" \
  || fail "session A did not reach the hand-off point"

grep -qi 'error' "$out_a" && { dump_sessions; fail "session A's compat write raised; the compatibility window is not accepting the previous release's insert"; }

a_shared="$(q "select count(*) from pg_locks l
                 join pg_stat_activity s on s.pid = l.pid
                where l.locktype = 'advisory' and l.mode = 'ShareLock' and l.granted
                  and s.application_name = 'replay_flip_a'")"
echo "  session A: inserted a contract directly under 'compat', uncommitted (shared flip locks held: $a_shared)"

# ---------------------------------------------------------------------------
# Session B: the real contract phase, as a whole transaction.
#
# lock_timeout is set generously for the staging half so the artifact's own 15s
# default cannot end the race before the barrier is read; the default and the
# timeout behaviour are measured on their own below.
# ---------------------------------------------------------------------------
PGAPPNAME=replay_flip_b PGOPTIONS="-c lock_timeout=${BARRIER_TIMEOUT}s" \
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$CONTRACT_PHASE" >"$out_b" 2>&1 &
B_PID=$!

case "$EXPECT" in
  serialized)
    if poll_for "select count(*) from pg_locks l
                   join pg_stat_activity s on s.pid = l.pid
                  where not l.granted and l.locktype = 'advisory'
                    and s.application_name = 'replay_flip_b'"; then
      b_blocked=1
      # Read from a third session, which can only see committed rows: this is the
      # measurement the finding is about.
      mode_while_blocked="$(q "select direct_write_mode from public.money_release_mode where id = 'only'")"
      echo "  session B: applied the contract phase and BLOCKED on the flip lock; committed mode is still '$mode_while_blocked'"
    else
      # Not a staging problem: nothing to block on is what an unserialized flip
      # looks like. Fall through and let the verdict say so.
      b_blocked=0
      mode_while_blocked="$(q "select direct_write_mode from public.money_release_mode where id = 'only'")"
      echo "  session B: applied the contract phase and did NOT block within ${BLOCK_TIMEOUT}s (committed mode '$mode_while_blocked')"
    fi
    ;;
  torn)
    wait_for "select count(*) from public.money_release_mode
               where id = 'only' and direct_write_mode = 'strict'" \
             "the flip did not commit 'strict' while A was open, so the guard mutation did not remove the serialization after all" \
      || fail "the control could not stage an unserialized flip"
    mode_while_blocked="$(q "select direct_write_mode from public.money_release_mode where id = 'only'")"
    echo "  session B: committed '$mode_while_blocked' while session A's compat write was still open"
    ;;
esac

# ---------------------------------------------------------------------------
# Session C: a write that STARTS while the flip is in the queue.
#
# This is the second half of the finding and it is not the same claim as session
# A's. A is the write that was already in flight; C is the write that arrives
# during the changeover. Both have to be settled, and they fail in opposite
# directions:
#
#   * if C did not wait, it would be judged by the posture that is being replaced
#     and would be ACCEPTED after 'strict' was already committed;
#   * if C waited but then read the mode from the snapshot it took before waiting,
#     it would ALSO be accepted — measured on PG 17.10 with the stable version of
#     the guard, which is the reason the guard is volatile. Waiting is necessary
#     and not sufficient; the fresh read after being let through is the other half.
#
# So all three properties are measured: C waits (its shared request is recorded in
# pg_locks as not granted, queued behind B's exclusive request — a conflicting
# waiter is not barged past), C is then REFUSED with the strict-posture message,
# and C changes no row.
#
# Only in the serialized mode: with the lock removed from the guard there is no
# queue to join, so "it waited" is not a property the control can have and the
# torn run stays the minimal reproduction it is.
# ---------------------------------------------------------------------------
if [ "$EXPECT" = "serialized" ] && [ "$b_blocked" = "1" ]; then
  # Unlike A, C does not have to be driven statement by statement: nothing in this
  # gate happens between its statements, so its whole transaction is written out in
  # advance and run as a file. That also keeps A the only coproc — bash supports one
  # cleanly, and a second live one warns — and means there is no pipe to write to
  # after psql has already exited on the refusal.
  #
  # It ends with COMMIT on purpose. If the insert were accepted, committing is what
  # makes the row visible, so the row count below is the defect rather than a
  # rollback hiding it. With ON_ERROR_STOP=1 a refused insert ends psql before the
  # COMMIT is ever read.
  #
  # VERBOSITY verbose so the refusal's SQLSTATE is in the log: "it raised" is not
  # the claim, "it raised 42501 from the strict posture" is.
  cat >"$work_dir/session_c.sql" <<SQL
\\set VERBOSITY verbose
set application_name = 'replay_flip_c';
set lock_timeout = '${BARRIER_TIMEOUT}s';
begin;
select set_config('request.jwt.claims',
                  json_build_object('sub', '$ACTOR', 'role', 'authenticated',
                                    'iat', floor(extract(epoch from now()))::bigint)::text,
                  true);
set local role authenticated;
insert into public.contracts (lead_id, sales_id, created_by, contract_no,
                              contract_amount, party_a_name, status)
values ('$LEAD_C', '$ACTOR', '$ACTOR', '$CONTRACT_NO_C', 1, 'x', 'draft');
commit;
SQL
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$work_dir/session_c.sql" >"$out_c" 2>&1 &
  C_PID=$!

  if poll_for "select count(*) from pg_locks l
                 join pg_stat_activity s on s.pid = l.pid
                where not l.granted and l.locktype = 'advisory' and l.mode = 'ShareLock'
                  and s.application_name = 'replay_flip_c'"; then
    c_waited=1
    echo "  session C: a NEW direct write started during the flip and is WAITING for the flip lock"
  else
    c_waited=0
    echo "  session C: a NEW direct write started during the flip and did NOT wait within ${BLOCK_TIMEOUT}s"
  fi
fi

# Hand-off: A commits. A write admitted under 'compat' must not fail.
a_send "commit;"
eval "exec ${A_IN}>&-"
A_IN=

wait "$A_PID" || { dump_sessions; fail "session A did not complete"; }
A_PID=
wait "$B_PID" || { dump_sessions; fail "the contract phase did not apply"; }
B_PID=

grep -qi 'error' "$out_a" && { dump_sessions; fail "session A reported an error; the compat write must survive the flip it raced"; }

a_committed="$(q "select count(*) from public.contracts where contract_no = '$CONTRACT_NO'")"
final_mode="$(q "select direct_write_mode from public.money_release_mode where id = 'only'")"
echo "  after both: A's contract rows committed = $a_committed, mode = '$final_mode'"

# Session C's outcome, now that 'strict' is committed and its shared request has
# been granted. rc 3 is psql stopping on the refusal; rc 0 would mean its COMMIT
# was reached, which the row count then reports.
if [ -n "${C_PID:-}" ]; then
  set +e
  wait "$C_PID"
  c_rc=$?
  set -e
  C_PID=
  c_refused="$(sed -n 's/.*ERROR:  \(42501\): contracts are created through create_contract(); \(direct insert is not permitted\).*/\1 \2/p' "$out_c" | head -1)"
  c_rows="$(q "select count(*) from public.contracts where contract_no = '$CONTRACT_NO_C'")"
  echo "  session C once the flip had committed: rc=$c_rc, reported '${c_refused:-no strict refusal}', rows committed = $c_rows"
fi

# ---------------------------------------------------------------------------
# The other half of "waits for in-flight writes to drain": what happens when it
# cannot. Only in the serialized mode — with the lock removed there is nothing to
# time out on.
# ---------------------------------------------------------------------------
drain_state=''
if [ "$EXPECT" = "serialized" ]; then
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -c "select public.money_set_direct_write_mode('compat', 'mode-flip gate: staging the drain timeout')" \
    >"$work_dir/recompat.log" 2>&1 || { cat "$work_dir/recompat.log" >&2; fail "could not return to 'compat' for the drain-timeout half"; }

  coproc D_SESSION { psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 >"$out_d" 2>&1; }
  D_IN="${D_SESSION[1]}"
  D_PID="$D_SESSION_PID"
  printf '%s\n' "set application_name = 'replay_flip_d';
        set idle_in_transaction_session_timeout = '${BARRIER_TIMEOUT}s';
        begin;
        select set_config('request.jwt.claims',
                          json_build_object('sub', '$ACTOR', 'role', 'authenticated',
                                            'iat', floor(extract(epoch from now()))::bigint)::text,
                          true);
        set local role authenticated;
        insert into public.contracts (lead_id, sales_id, created_by, contract_no,
                                      contract_amount, party_a_name, status)
        values ('$LEAD_B', '$ACTOR', '$ACTOR', '$CONTRACT_NO_B', 1, 'x', 'draft');
        select pg_advisory_xact_lock($MARK_HI, $((MARK_LO + 1)));" >&"$D_IN" || true

  wait_for "select count(*) from pg_locks
             where locktype = 'advisory' and classid = $MARK_HI and objid = $((MARK_LO + 1)) and granted" \
           "the second compat write never reached the hand-off point" \
    || fail "could not stage the drain-timeout half"

  # The artifact's own bounded wait, with the operator's lock_timeout honoured —
  # 2s here so the measurement costs 2s instead of the 15s default.
  set +e
  PGAPPNAME=replay_flip_drain PGOPTIONS="-c lock_timeout=$DRAIN_TIMEOUT" \
    psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$CONTRACT_PHASE" >"$out_e" 2>&1
  drain_rc=$?
  set -e
  drain_state="$(sed -n 's/.*canceling statement due to \(lock timeout\).*/\1/p' "$out_e" | head -1)"
  echo "  drain timeout: the flip refused to wait past $DRAIN_TIMEOUT (rc=$drain_rc, reported '${drain_state:-nothing}')"

  eval "exec ${D_IN}>&-"
  D_IN=
  wait "$D_PID" 2>/dev/null || true
  D_PID=
fi

# ---------------------------------------------------------------------------
# Cleanup before the verdict, so a failing gate still leaves the database in the
# state the fixtures created and the posture it was found in.
# ---------------------------------------------------------------------------
restore_guard || fail "could not restore public.money_direct_write_is_blocked() after the control's mutation"

cat >"$work_dir/teardown.sql" <<SQL
delete from public.contracts where contract_no in ('$CONTRACT_NO', '$CONTRACT_NO_B', '$CONTRACT_NO_C');
delete from public.leads where id in ('$LEAD', '$LEAD_B', '$LEAD_C');
select public.money_set_direct_write_mode('$entry_mode',
  'supabase/replay/17_concurrency_mode_flip.sh: restoring the posture the gate was invoked under');
SQL
if ! psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
     -f "$work_dir/teardown.sql" >"$work_dir/teardown.log" 2>&1; then
  cat "$work_dir/teardown.log" >&2
  fail "could not remove the mode-flip fixtures"
fi
left="$(q "select count(*) from public.contracts where contract_no in ('$CONTRACT_NO', '$CONTRACT_NO_B', '$CONTRACT_NO_C')")"
[ "$left" = "0" ] || fail "the mode-flip fixtures did not clean up ($left contract row(s) left behind)"

# All three leads, counted one at a time. A single count over an IN list reports
# zero when one of them is gone and cannot say which, and a lead left behind is a
# lead the next gate's uniqueness index has to reason about.
lead_left="$(q "select count(*) from public.leads where id = '$LEAD'")"
lead_b_left="$(q "select count(*) from public.leads where id = '$LEAD_B'")"
lead_c_left="$(q "select count(*) from public.leads where id = '$LEAD_C'")"
[ "$lead_left" = "0" ] || fail "the mode-flip lead $LEAD was left behind ($lead_left row(s))"
[ "$lead_b_left" = "0" ] || fail "the mode-flip lead $LEAD_B was left behind ($lead_b_left row(s))"
[ "$lead_c_left" = "0" ] || fail "the mode-flip lead $LEAD_C was left behind ($lead_c_left row(s))"

# And the lock itself. Every holder of the flip key is a transaction that ended;
# advisory xact locks are released at commit or rollback, so anything still
# recorded on this key means a session of this gate's is still open and the next
# gate would block on it rather than measure anything. Matched on the key, not on
# 'any advisory lock', so an unrelated gate's marker cannot fail this or hide it:
# pg_locks.classid/objid are oid, hence unsigned, so the 64-bit key reassembles
# without a sign correction.
flip_locks="$(q "select count(*) from pg_locks
                  where locktype = 'advisory' and objsubid = 1
                    and (classid::bigint << 32) | objid::bigint
                        = public.money_release_mode_lock_key()")"
[ "$flip_locks" = "0" ] || fail "$flip_locks advisory lock(s) on the flip key ($FLIP_KEY) are still held after the gate finished"

[ "$(q "select direct_write_mode from public.money_release_mode where id = 'only'")" = "$entry_mode" ] \
  || fail "the release mode was not restored to '$entry_mode'"
echo "  cleanup: contracts=$left, lead=$lead_left, lead_b=$lead_b_left, lead_c=$lead_c_left, flip advisory locks=$flip_locks, mode='$entry_mode'"

# ---------------------------------------------------------------------------
# The verdict.
# ---------------------------------------------------------------------------
case "$EXPECT" in
  serialized)
    [ "$a_committed" = "1" ] || {
      dump_sessions
      fail "the compat write did not commit ($a_committed row(s)); the flip must wait for the previous release's write, not defeat it"
    }
    [ "$b_blocked" = "1" ] || {
      dump_sessions
      fail "UNSERIALIZED FLIP: the contract phase never waited for the in-flight compat write. public.money_direct_write_is_blocked() is not taking pg_advisory_xact_lock_shared(public.money_release_mode_lock_key()) = $FLIP_KEY, or the contract phase is not taking it exclusively"
    }
    [ "$mode_while_blocked" = "compat" ] || {
      dump_sessions
      fail "the contract phase blocked, but the committed mode was already '$mode_while_blocked' while the compat write was still open — 'strict' became true before the write it was supposed to be waiting for finished"
    }
    [ "$final_mode" = "strict" ] || {
      dump_sessions
      fail "the contract phase blocked and then left the mode at '$final_mode'; it must reach 'strict' once the in-flight write has drained"
    }
    # The write that arrived during the flip: all three properties, in order.
    [ "$c_waited" = "1" ] || {
      dump_sessions
      fail "A WRITE CROSSED THE FLIP: the direct write that started while the contract phase was queued did not wait for the flip lock. It was judged by the posture being replaced, not by the one that committed"
    }
    [ "$c_refused" = "42501 direct insert is not permitted" ] || {
      dump_sessions
      fail "the write that started during the flip waited and was then ACCEPTED, or refused for another reason (saw '${c_refused:-no strict refusal}'). Waiting is not enough: money_direct_write_is_blocked() must read the mode AFTER the lock is granted, which is why it is volatile — a stable body reads the caller's pre-lock snapshot and lets the write through"
    }
    [ "$c_rows" = "0" ] || {
      dump_sessions
      fail "the write that started during the flip was refused but left $c_rows row(s) behind; a refusal that changes a row is not a refusal"
    }
    [ "$drain_state" = "lock timeout" ] || {
      dump_sessions
      fail "the flip did not report a lock timeout when the compat write refused to drain (saw '${drain_state:-nothing}'); an operator whose flip cannot drain must be told, not left waiting while every money write queues behind the lock request"
    }
    echo "  flip serialization OK: the contract phase waited for the in-flight compat write, 'strict' was not committed until that write had, a write that started during the flip waited and was then refused 42501 with no row change, and a flip that cannot drain fails with a lock timeout"
    ;;
  torn)
    [ "$mode_while_blocked" = "strict" ] || fail "the control did not commit 'strict' while the compat write was open ('$mode_while_blocked'), so it proves nothing about the fix"
    [ "$a_committed" = "1" ] || fail "the control's compat write did not commit ($a_committed row(s)); the defect is that it commits AFTER 'strict', so it has to commit"
    echo "  control OK: without the lock the flip committed 'strict' while a direct compat write was still in flight, and that write then committed underneath it"
    ;;
esac
