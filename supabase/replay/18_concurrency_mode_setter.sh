#!/usr/bin/env bash
# ============================================================================
# The granted route into the posture, under the same lock
# ============================================================================
# Round-4 C4-3, second half. 17_concurrency_mode_flip.sh proves the three hand-run
# artifacts — the contract phase, the rollback companion and the re-contract
# companion — cannot commit a new posture over an in-flight direct write. They are
# not the only way the posture moves. public.money_set_direct_write_mode(text,text)
# is the GRANTED route: service_role holds EXECUTE on it, and the release's own
# assertions call it to move the mode. Serializing the three files and leaving the
# function unlocked means the serialization holds only for as long as every caller
# chooses the artifact over the function.
#
# So this gate measures the function directly, and it needs two sessions for the
# same reason: sequentially the setter works in both versions.
#
#   EXPECT=serialized   the setter WAITS for an in-flight direct write. Bounded by
#                       the caller's lock_timeout, so the wait is observable as a
#                       55P03 rather than as a hang, and the mode is unchanged
#                       afterwards. Once the write commits, the same call succeeds.
#
#   EXPECT=torn         the same call with the lock removed from the setter's body:
#                       it commits the new posture immediately, while the write it
#                       is supposed to be ending is still open.
#
# The mutation is made to the function in this throwaway replay database, captured
# with pg_get_functiondef() first and restored from that capture afterwards, and
# the gate fails if the restored definition is not byte-identical. Note what is NOT
# mutated: money_direct_write_is_blocked() keeps its shared lock in both modes, so
# the only difference between the two runs is whether the setter asks for the
# exclusive half.
#
# EXPECT is mandatory and has no default, because defaulting it is how a control
# run silently asserts the branch claim. One lead and one contract of this gate's
# own, on fixed UUIDs, removed again at the end; the posture found on entry is
# restored. Requires psql on PATH and PG* pointing at the replay database.
# ============================================================================
set -euo pipefail

: "${EXPECT:?EXPECT must be 'serialized' (with the lock) or 'torn' (setter mutated to drop it)}"
case "$EXPECT" in
  serialized|torn) ;;
  *) echo "mode-setter gate: EXPECT must be 'serialized' or 'torn', got '$EXPECT'" >&2; exit 1 ;;
esac

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

ACTOR='cccccccc-cccc-cccc-cccc-cccccccccccc'
LEAD='18181818-1818-1818-1818-181818181818'
CONTRACT_NO='REPLAY-SETTER-COMPAT-1'
MARK_HI=918273
MARK_LO=650                                    # 645/646 belong to 15_/16_; 17_ takes 648 and 649
                                               # (it derives its second marker as MARK_LO + 1)
BARRIER_TIMEOUT="${BARRIER_TIMEOUT:-90}"
SETTER_TIMEOUT="${SETTER_TIMEOUT:-1s}"
entry_mode=''
setter_def=''
mutated=0

work_dir="$(mktemp -d)"
out_a="$work_dir/session_a.log"
out_b="$work_dir/session_b.log"

PSQL_Q=(psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1)
SETTER='public.money_set_direct_write_mode(text, text)'

fail() { echo "mode-setter gate failed: $*" >&2; exit 1; }
q() { "${PSQL_Q[@]}" -c "$1" | tr -d '[:space:]'; }
q_raw() { "${PSQL_Q[@]}" -c "$1"; }

dump_sessions() {
  for log in "$out_a" "$out_b"; do
    [ -f "$log" ] || continue
    echo "--- $(basename "$log") ---" >&2
    cat "$log" >&2
  done
}

restore_setter() {
  [ "$mutated" = "1" ] || return 0
  [ -s "$work_dir/setter.sql" ] || { echo "mode-setter gate: the captured definition is missing; the mutation cannot be undone" >&2; return 1; }
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/setter.sql" >"$work_dir/restore.log" 2>&1 || { cat "$work_dir/restore.log" >&2; return 1; }
  mutated=0
  [ "$(q_raw "select pg_get_functiondef('$SETTER'::regprocedure)")" = "$setter_def" ] || {
    echo "mode-setter gate: the setter was restored but is not byte-identical to the definition captured on entry" >&2
    return 1
  }
  return 0
}

cleanup() {
  local status=$?
  if [ -n "${A_IN:-}" ]; then eval "exec ${A_IN}>&-" 2>/dev/null || true; fi
  [ -n "${A_PID:-}" ] && wait "$A_PID" 2>/dev/null || true
  restore_setter || status=1
  rm -rf "$work_dir"
  return $status
}
trap cleanup EXIT

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"
[ "$(q "select count(*) from public.money_release_mode where id = 'only'")" = "1" ] \
  || fail "public.money_release_mode has no 'only' row"
[ "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'money_release_mode_lock_key'")" = "1" ] \
  || fail "public.money_release_mode_lock_key() does not exist, so the setter has no lock to take"
[ "$(q "select count(*) from public.profiles where id = '$ACTOR' and coalesce(is_active, false)")" = "1" ] \
  || fail "fixture actor $ACTOR is missing or not active"

FLIP_KEY="$(q "select public.money_release_mode_lock_key()")"
setter_def="$(q_raw "select pg_get_functiondef('$SETTER'::regprocedure)")"
[ -n "$setter_def" ] || fail "could not capture the setter definition, so a mutation could not be undone"
printf '%s\n' "$setter_def" >"$work_dir/setter.sql"

entry_mode="$(q "select direct_write_mode from public.money_release_mode where id = 'only'")"
case "$entry_mode" in compat|strict) ;; *) fail "the mode on entry is '$entry_mode'" ;; esac

if [ "$EXPECT" = "torn" ]; then
  # The setter as it was before C4-3: validation, then straight to the write.
  cat >"$work_dir/mutate.sql" <<'SQL'
create or replace function public.money_set_direct_write_mode(p_mode text, p_reason text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if p_mode not in ('compat', 'strict') then
    raise exception 'mode must be compat or strict, got %', coalesce(p_mode, 'null')
      using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to change the direct write mode' using errcode = '22023';
  end if;

  insert into public.money_release_mode (id, direct_write_mode, reason, changed_by, changed_at)
  values ('only', p_mode, btrim(p_reason), v_actor, now())
  on conflict (id) do update
     set direct_write_mode = excluded.direct_write_mode,
         reason            = excluded.reason,
         changed_by        = excluded.changed_by,
         changed_at        = excluded.changed_at;

  return p_mode;
end
$$;
SQL
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction -f "$work_dir/mutate.sql" \
    >"$work_dir/mutate.log" 2>&1 || { cat "$work_dir/mutate.log" >&2; fail "could not install the un-serialized setter"; }
  mutated=1
  echo "  control: $SETTER replaced with the pre-C4-3, lock-free definition"
fi

cat >"$work_dir/setup.sql" <<SQL
delete from public.contracts where contract_no = '$CONTRACT_NO';
delete from public.leads where id = '$LEAD';
insert into public.leads (id, assigned_to, stage, customer_name, source)
values ('$LEAD', '$ACTOR', 'won', 'Replay mode-setter lead', 'other');
select public.money_set_direct_write_mode('compat',
  'supabase/replay/18_concurrency_mode_setter.sh: staging the compatibility window');
SQL
psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction -f "$work_dir/setup.sql" \
  >"$work_dir/setup.log" 2>&1 || { cat "$work_dir/setup.log" >&2; fail "could not stage the compatibility window"; }
[ "$(q "select public.money_direct_write_mode()")" = "compat" ] \
  || fail "the mode is not 'compat' after staging"

echo "  staging a direct compat write against public.money_set_direct_write_mode()"

coproc A_SESSION { psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 >"$out_a" 2>&1; }
A_IN="${A_SESSION[1]}"
A_PID="$A_SESSION_PID"

printf '%s\n' "set application_name = 'replay_setter_a';
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
  select pg_advisory_xact_lock($MARK_HI, $MARK_LO);" >&"$A_IN" || true

deadline=$((SECONDS + BARRIER_TIMEOUT))
while [ "$(q "select count(*) from pg_locks
               where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO and granted")" = "0" ]; do
  [ "$SECONDS" -ge "$deadline" ] && { dump_sessions; fail "session A never finished its direct insert"; }
  sleep 0.2
done
grep -qi 'error' "$out_a" && { dump_sessions; fail "session A's compat write raised"; }

a_shared="$(q "select count(*) from pg_locks l join pg_stat_activity s on s.pid = l.pid
                where l.locktype = 'advisory' and l.mode = 'ShareLock' and l.granted
                  and s.application_name = 'replay_setter_a'")"
echo "  session A: inserted a contract directly under 'compat', uncommitted (shared flip locks held: $a_shared)"
[ "$a_shared" = "0" ] && { dump_sessions; fail "the in-flight write is not holding the shared flip lock, so this gate would measure nothing about the setter"; }

# The call under test, from a second session, with a bounded wait. A setter that
# takes the exclusive half cannot get it while A holds the shared half, and says so
# in 55P03 instead of writing.
set +e
PGAPPNAME=replay_setter_b PGOPTIONS="-c lock_timeout=$SETTER_TIMEOUT" \
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -c "select public.money_set_direct_write_mode('strict',
          'supabase/replay/18_concurrency_mode_setter.sh: the granted route into the strict posture')" \
    >"$out_b" 2>&1
setter_rc=$?
set -e
setter_state="$(sed -n 's/.*canceling statement due to \(lock timeout\).*/\1/p' "$out_b" | head -1)"
mode_during="$(q "select direct_write_mode from public.money_release_mode where id = 'only'")"
echo "  setter while the write is in flight: rc=$setter_rc, reported '${setter_state:-no error}', committed mode '$mode_during'"

# Hand-off, then the same call again with nothing in flight.
printf '%s\n' "commit;" >&"$A_IN" || true
eval "exec ${A_IN}>&-"
A_IN=
wait "$A_PID" || { dump_sessions; fail "session A did not complete"; }
A_PID=
grep -qi 'error' "$out_a" && { dump_sessions; fail "session A reported an error; a write admitted under 'compat' must not fail"; }

set +e
PGOPTIONS="-c lock_timeout=$SETTER_TIMEOUT" \
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -c "select public.money_set_direct_write_mode('strict',
          'supabase/replay/18_concurrency_mode_setter.sh: the same call once the write has drained')" \
    >>"$out_b" 2>&1
after_rc=$?
set -e
mode_after="$(q "select direct_write_mode from public.money_release_mode where id = 'only'")"
a_committed="$(q "select count(*) from public.contracts where contract_no = '$CONTRACT_NO'")"
echo "  setter once it has drained: rc=$after_rc, committed mode '$mode_after', A's rows committed = $a_committed"

restore_setter || fail "could not restore $SETTER after the control's mutation"

cat >"$work_dir/teardown.sql" <<SQL
delete from public.contracts where contract_no = '$CONTRACT_NO';
delete from public.leads where id = '$LEAD';
select public.money_set_direct_write_mode('$entry_mode',
  'supabase/replay/18_concurrency_mode_setter.sh: restoring the posture the gate was invoked under');
SQL
psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction -f "$work_dir/teardown.sql" \
  >"$work_dir/teardown.log" 2>&1 || { cat "$work_dir/teardown.log" >&2; fail "could not remove the mode-setter fixtures"; }
[ "$(q "select count(*) from public.contracts where contract_no = '$CONTRACT_NO'")" = "0" ] \
  || fail "the mode-setter contract fixture did not clean up"
[ "$(q "select count(*) from public.leads where id = '$LEAD'")" = "0" ] \
  || fail "the mode-setter lead fixture did not clean up"
[ "$(q "select direct_write_mode from public.money_release_mode where id = 'only'")" = "$entry_mode" ] \
  || fail "the release mode was not restored to '$entry_mode'"

case "$EXPECT" in
  serialized)
    [ "$a_committed" = "1" ] || { dump_sessions; fail "the compat write did not commit ($a_committed row(s))"; }
    [ "$setter_rc" != "0" ] || {
      dump_sessions
      fail "UNSERIALIZED SETTER: public.money_set_direct_write_mode() changed the posture while a direct compat write was still in flight. It is not taking pg_advisory_xact_lock(public.money_release_mode_lock_key()) = $FLIP_KEY before the write"
    }
    [ "$setter_state" = "lock timeout" ] || {
      dump_sessions
      fail "the setter failed while the write was in flight, but not by waiting for the lock (saw '${setter_state:-no error}'); the refusal has to be the lock, not an unrelated error"
    }
    [ "$mode_during" = "compat" ] || {
      dump_sessions
      fail "the setter timed out on the lock and the committed mode is '$mode_during' anyway; the posture must be unchanged when the write did not happen"
    }
    [ "$after_rc" = "0" ] && [ "$mode_after" = "strict" ] || {
      dump_sessions
      fail "the same call did not succeed once the write had drained (rc=$after_rc, mode '$mode_after'); the lock must delay a posture change, not prevent it"
    }
    echo "  setter serialization OK: the granted route waited for the in-flight compat write, left the posture unchanged when it could not get the lock, and succeeded once the write had drained"
    ;;
  torn)
    [ "$setter_rc" = "0" ] || fail "the control's setter did not succeed while the write was open (rc=$setter_rc), so it proves nothing about the fix"
    [ "$mode_during" = "strict" ] || fail "the control's setter returned 0 but the committed mode was '$mode_during'"
    [ "$a_committed" = "1" ] || fail "the control's compat write did not commit ($a_committed row(s)); the defect is that it commits after the posture changed"
    echo "  control OK: without the lock the granted route committed 'strict' while a direct compat write was still in flight, and that write then committed underneath it"
    ;;
esac
